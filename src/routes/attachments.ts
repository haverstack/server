import { Hono } from 'hono';
import { readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';
import { checkAccess } from '../lib/access.js';

export function attachmentRoutes(ctx: StackContext, dbPath: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;
  const attachmentsDir = join(dirname(dbPath), 'attachments');

  // POST /attachments — upload raw binary, Content-Type = MIME type
  app.post('/', requireAuth(), async (c) => {
    const mimeType = c.req.header('Content-Type') ?? 'application/octet-stream';
    const data = new Uint8Array(await c.req.arrayBuffer());
    const fileId = await adapter.putAttachment(data, mimeType);
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

    // Use getAttachmentMeta for accurate MIME type and early-404 before reading binary.
    let mimeType = 'application/octet-stream';
    if (adapter.getAttachmentMeta) {
      const meta = await adapter.getAttachmentMeta(fileId);
      if (!meta) return c.json({ error: 'Attachment not found' }, 404);
      mimeType = meta.mimeType;
    }

    let data: Uint8Array;
    try {
      data = await adapter.getAttachment(fileId);
    } catch {
      return c.json({ error: 'Attachment not found' }, 404);
    }

    return c.newResponse(data, 200, {
      'Content-Type': mimeType,
      'Content-Length': String(data.byteLength),
    });
  });

  // DELETE /attachments/:fileId
  app.delete('/:fileId', requireAuth(), async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth')!;
    if (!ownerEntityId || auth.entityId !== ownerEntityId)
      return c.json({ error: 'Forbidden' }, 403);

    if (adapter.getAttachmentMeta) {
      const meta = await adapter.getAttachmentMeta(fileId);
      if (!meta) return c.json({ error: 'Attachment not found' }, 404);
    }

    await adapter.deleteAttachment(fileId);
    deleteAttachmentFile(attachmentsDir, fileId);
    return c.body(null, 204);
  });

  return app;
}

function deleteAttachmentFile(attachmentsDir: string, fileId: string): void {
  try {
    const entries = readdirSync(attachmentsDir) as string[];
    for (const f of entries) {
      if (f.startsWith(fileId + '.')) {
        unlinkSync(join(attachmentsDir, f));
        break;
      }
    }
  } catch {
    // Non-fatal — DB row is already removed.
  }
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
