import { Hono } from 'hono';
import { parseBlobsParams } from '@haverstack/core/wire';
import { serializeBlobInfo } from '@haverstack/wire-types';
import type { WireBlobsResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import { requireAuth } from '../middleware/auth.js';
import { readPage } from '../lib/page.js';

/**
 * GET /blobs — every blob the store holds, fileId ascending, so the owner
 * can read a hosted stack in full. ScopedStack.listBlobs() refuses all
 * but the owner acting alone: a listing names files no Record the
 * requester reaches names.
 * See docs/spec/wire-format.md § Blobs.
 */
export function blobRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', requireAuth(), async (c) => {
    const query = parseBlobsParams(new URL(c.req.url));
    const scope = c.get('scope');
    const { rows, cursor } = await readPage(
      query.limit,
      (limit) => scope.listBlobs({ ...query, limit }),
      (blob) => blob.fileId,
    );
    const body: WireBlobsResponse = { blobs: rows.map(serializeBlobInfo), cursor };
    return c.json(body);
  });

  return app;
}
