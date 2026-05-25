import { Hono } from 'hono';
import { readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppEnv } from '../app.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';
import { checkAccess } from '../lib/access.js';

export function attachmentRoutes(ctx: StackContext, dbPath: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // Directory where the SQLite adapter stores attachment files.
  // Mirrors the adapter's convention: attachments/ next to the .db file.
  const attachmentsDir = join(dirname(dbPath), 'attachments');

  // ----------------------------------------------------------------
  // POST /attachments — upload a file
  // Body: raw binary, Content-Type: the file's MIME type
  // ----------------------------------------------------------------
  app.post('/', requireAuth(), async (c) => {
    const mimeType = c.req.header('Content-Type') ?? 'application/octet-stream';
    const data = new Uint8Array(await c.req.arrayBuffer());
    const fileId = await adapter.putAttachment(data, mimeType);
    return c.json({ fileId }, 201);
  });

  // ----------------------------------------------------------------
  // GET /attachments/:fileId — download a file
  // ----------------------------------------------------------------
  app.get('/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth');

    if (!auth) {
      // Unauthenticated: allow only if referenced by a public record.
      const accessible = await isAttachmentPublic(fileId, ctx);
      if (!accessible) return c.json({ error: 'Unauthorized' }, 401);
    }

    let data: Uint8Array;
    try {
      data = await adapter.getAttachment(fileId);
    } catch {
      return c.json({ error: 'Attachment not found' }, 404);
    }

    const mimeType = detectMimeType(attachmentsDir, fileId);
    return c.newResponse(data, 200, {
      'Content-Type': mimeType,
      'Content-Length': String(data.byteLength),
    });
  });

  // ----------------------------------------------------------------
  // DELETE /attachments/:fileId
  // ----------------------------------------------------------------
  app.delete('/:fileId', requireAuth(), async (c) => {
    const fileId = c.req.param('fileId');
    const auth = c.get('auth')!;

    if (!ownerEntityId || auth.entityId !== ownerEntityId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Adapter removes the DB row; we clean up the file ourselves.
    await adapter.deleteAttachment(fileId);
    deleteAttachmentFile(attachmentsDir, fileId);

    return c.body(null, 204);
  });

  return app;
}

function detectMimeType(attachmentsDir: string, fileId: string): string {
  try {
    const entries = readdirSync(attachmentsDir) as string[];
    const file = entries.find((f) => f.startsWith(fileId + '.'));
    if (!file) return 'application/octet-stream';
    const ext = file.split('.').pop() ?? '';
    return extToMime[ext] ?? 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
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
    // Best-effort; row is already removed so this is non-fatal.
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

const extToMime: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  json: 'application/json',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  bin: 'application/octet-stream',
};
