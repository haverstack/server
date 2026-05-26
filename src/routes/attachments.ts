import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';
import { checkAccess } from '../lib/access.js';

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

    const mimeType = c.req.header('Content-Type') ?? 'application/octet-stream';
    const filename = parseFilename(c.req.header('Content-Disposition'));

    const fileId = await adapter.putAttachment(data, mimeType, filename);
    return c.json({ fileId }, 201);
  });

  // GET /attachments/:fileId — download
  app.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth');

    if (!auth) {
      const accessible = await isAttachmentPublic(fileId, ctx);
      if (!accessible) return c.json({ error: 'Unauthorized' }, 401);
    }

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

    return c.newResponse(data, 200, headers);
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

async function isAttachmentPublic(fileId: string, ctx: StackContext): Promise<boolean> {
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;
  let cursor: string | undefined;
  do {
    const result = await adapter.queryRecords({ limit: 200, ...(cursor && { cursor }) });
    for (const record of result.records) {
      const hasRef = record.associations?.some(
        (a) => a.kind === 'attachment' && a.fileId === fileId,
      );
      if (hasRef) {
        const readable = await checkAccess(record, null, ownerEntityId, 'read', adapter);
        if (readable) return true;
      }
    }
    cursor = result.cursor ?? undefined;
  } while (cursor);
  return false;
}
