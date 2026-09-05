import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { serializeRecord } from '@haverstack/wire-types';
import { StackNotFoundError } from '@haverstack/core';

export function entityRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  app.get('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const record = await stack.forSession(auth).getOwnerEntity();
    if (!record) throw new StackNotFoundError('Entity record not found');
    return c.json(serializeRecord(record));
  });

  app.patch('/', requireOwner(ownerEntityId), async (c) => {
    const auth = c.get('auth')!;
    const record = await stack.forSession(auth).getOwnerEntity();
    if (!record) throw new StackNotFoundError('Entity record not found');
    const body = await readJson<Record<string, unknown>>(c);
    const updated = await stack
      .forSession(auth)
      .update(record.id, (body.content ?? {}) as Record<string, unknown>);
    return c.json(serializeRecord(updated));
  });

  return app;
}
