import { Hono } from 'hono';
import { SYSTEM_TYPES } from '@haverstack/core';
import type { AttachmentContent } from '@haverstack/core';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';

export function attachmentRoutes(ctx: StackContext, maxAttachmentBytes: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const { ownerEntityId } = stack;

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

    const auth = c.get('auth');
    const fileId = await stack.asEntity(auth!.entityId).putAttachment(data, mimeType, filename);
    return c.json({ fileId }, 201);
  });

  // GET /attachments/:fileId — download
  app.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth');

    const accessible = await isAttachmentAccessible(fileId, auth?.entityId ?? null, ctx);
    if (!accessible) return c.json({ error: 'Unauthorized' }, 401);

    // Find the _attachment@1 record to get metadata
    const metaResult = await stack.query({
      filter: { typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`, content: { fileId } },
      limit: 1,
    });
    const attachmentContent = (metaResult.records[0]?.content as AttachmentContent) ?? null;

    if (!attachmentContent) return c.json({ error: 'Attachment not found' }, 404);

    let data: Uint8Array;
    try {
      data = await adapter.getAttachment(fileId);
    } catch {
      return c.json({ error: 'Attachment not found' }, 404);
    }

    const headers: Record<string, string> = {
      'Content-Type': attachmentContent.mimeType,
      'Content-Length': String(attachmentContent.size),
    };
    if (attachmentContent.filename) {
      headers['Content-Disposition'] = `attachment; filename="${attachmentContent.filename}"`;
    }

    return c.newResponse(data as unknown as Uint8Array<ArrayBuffer>, 200, headers);
  });

  // DELETE /attachments/:fileId
  app.delete('/:fileId', requireOwner(ownerEntityId), async (c) => {
    const fileId = c.req.param('fileId');

    // Find all _attachment@1 records tracking this file
    const metaResult = await stack.query({
      filter: { typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`, content: { fileId } },
    });
    const attachmentRecords = metaResult.records;

    if (!attachmentRecords.length) return c.json({ error: 'Attachment not found' }, 404);

    for (const record of attachmentRecords) {
      await stack.delete(record.id, { hard: true });
    }

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
 * An attachment is accessible if:
 * 1. The requester is the stack owner, OR
 * 2. The requester can read at least one Record that references the file, OR
 * 3. The requester uploaded the file (owns its _attachment@1 record) and it
 *    hasn't been associated with any record yet.
 */
async function isAttachmentAccessible(
  fileId: string,
  requesterEntityId: string | null,
  ctx: StackContext,
): Promise<boolean> {
  const { stack } = ctx;
  if (requesterEntityId && requesterEntityId === stack.ownerEntityId) return true;

  const result = await stack.asEntity(requesterEntityId).query({
    filter: { attachmentFileId: fileId },
    limit: 1,
  });
  if (result.records.length > 0) return true;

  // Unassociated file: check if the requester uploaded it
  if (requesterEntityId) {
    const uploadResult = await stack.query({
      filter: {
        typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`,
        entityId: requesterEntityId,
        content: { fileId },
      },
      limit: 1,
    });
    if (uploadResult.records.length > 0) return true;
  }

  return false;
}
