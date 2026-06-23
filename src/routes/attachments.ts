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

    const accessible = await isAttachmentAccessible(fileId, auth?.entityId ?? null, ctx);
    if (!accessible) return c.json({ error: 'Unauthorized' }, 401);

    let data: Uint8Array;
    try {
      data = await adapter.getAttachment(fileId);
    } catch {
      return c.json({ error: 'Attachment not found' }, 404);
    }

    const contentTypeParam = c.req.query('contentType');
    const filenameParam = c.req.query('filename');

    // Skip the _attachment@1 lookup entirely when the caller supplies both values.
    // Otherwise query once and extract whatever is still needed.
    let recordMimeType: string | undefined;
    let recordFilename: string | undefined;
    if (!contentTypeParam || !filenameParam) {
      const metaResult = await stack.query({
        filter: { typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`, content: { fileId } },
      });
      recordMimeType = (metaResult.records[0]?.content as AttachmentContent | undefined)?.mimeType;
      // Filename is pure metadata — only expose it from the requester's own record.
      const ownRecord = metaResult.records.find((r) => r.entityId === auth?.entityId);
      recordFilename = (ownRecord?.content as AttachmentContent | undefined)?.filename;
    }

    const resolvedFilename = filenameParam ?? recordFilename;
    const disposition = resolvedFilename
      ? `attachment; filename*=UTF-8''${encodeURIComponent(resolvedFilename)}`
      : 'attachment';

    const headers: Record<string, string> = {
      'Content-Type': sanitizeMimeType(
        contentTypeParam ?? recordMimeType ?? 'application/octet-stream',
      ),
      'Content-Length': String(data.byteLength),
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
    };

    return c.newResponse(data as unknown as Uint8Array<ArrayBuffer>, 200, headers);
  });

  // DELETE /attachments/:fileId
  app.delete('/:fileId', requireOwner(ownerEntityId), async (c) => {
    const fileId = c.req.param('fileId');

    // Find any _attachment@1 metadata record(s) for this file
    const metaResult = await stack.query({
      filter: { typeId: `${SYSTEM_TYPES.ATTACHMENT}@1`, content: { fileId } },
    });

    // If no metadata record, verify the bytes actually exist before proceeding
    if (!metaResult.records.length) {
      try {
        await adapter.getAttachment(fileId);
      } catch {
        return c.json({ error: 'Attachment not found' }, 404);
      }
    }

    // Refuse if any record in the stack still references this file
    const refResult = await stack.query({ filter: { attachmentFileId: fileId }, limit: 1 });
    if (refResult.records.length > 0) {
      return c.json({ error: 'Attachment is still referenced by one or more records' }, 409);
    }

    for (const record of metaResult.records) {
      await stack.delete(record.id, { hard: true });
    }

    await adapter.deleteAttachment(fileId);
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
