import { Hono } from 'hono';
import { parseBlobsParams } from '@haverstack/core/wire';
import { serializeBlobInfo } from '@haverstack/wire-types';
import type { WireBlobsResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { readPage } from '../lib/page.js';

/**
 * GET /blobs — every blob the store holds, fileId ascending, so the owner
 * can read a hosted stack in full. Owner acting alone: a listing names
 * files no Record the requester reaches names, so no grant confers it.
 * See docs/spec/wire-format.md § Blobs.
 */
export function blobRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;

  app.get('/', requireOwner(stack.ownerEntityId), async (c) => {
    const query = parseBlobsParams(new URL(c.req.url));
    const { rows, cursor } = await readPage(
      query.limit,
      (limit) => adapter.listBlobs({ ...query, limit }),
      (blob) => blob.fileId,
    );
    const body: WireBlobsResponse = { blobs: rows.map(serializeBlobInfo), cursor };
    return c.json(body);
  });

  return app;
}
