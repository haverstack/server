import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { serializeRecord } from '@haverstack/wire-types';
import { parseContentPatchBody, parseIfMatch } from '@haverstack/core/wire';
import { StackNotFoundError } from '@haverstack/core';

export function entityRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  app.get('/', knownParams(), requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const record = await stack.asActor(auth).getOwnerEntity();
    if (!record) throw new StackNotFoundError('Entity record not found');
    return c.json(serializeRecord(record));
  });

  // An alias for PATCH /records/:id/content on the owner's entity record,
  // so it takes the same bare patch and the same If-Match.
  // See docs/spec/wire-format.md § Entity.
  app.patch('/content', knownParams(), requireOwner(ownerEntityId), async (c) => {
    const auth = c.get('auth')!;
    const patch = parseContentPatchBody(await readJson(c));
    const record = await stack.asActor(auth).getOwnerEntity();
    if (!record) throw new StackNotFoundError('Entity record not found');
    const updated = await stack
      .asActor(auth)
      .patchContent(record.id, patch, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord(updated));
  });

  return app;
}
