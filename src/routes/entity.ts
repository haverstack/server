import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import { requireAuth } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { serializeRecord } from '@haverstack/wire-types';
import { parseContentPatchBody } from '@haverstack/core/wire';
import { ifMatchVersion } from '../lib/ifMatch.js';
import { StackNotFoundError } from '@haverstack/core';

export function entityRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', knownParams(), requireAuth(), async (c) => {
    const record = await c.get('scope').getOwnerEntity();
    if (!record) throw new StackNotFoundError('Entity record not found');
    return c.json(serializeRecord(record));
  });

  // An alias for PATCH /records/:id/content on the owner's entity record,
  // so it takes the same bare patch, the same If-Match and the same write
  // gate, which ScopedStack decides. See docs/spec/wire-format.md § Entity.
  app.patch('/content', knownParams(), requireAuth(), async (c) => {
    const scoped = c.get('scope');
    const patch = parseContentPatchBody(await readJson(c));
    const record = await scoped.getOwnerEntity();
    if (!record) throw new StackNotFoundError('Entity record not found');
    const updated = await scoped.patchContent(record.id, patch, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  return app;
}
