import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { serializeRecord } from '../lib/serialize.js';

export function entityRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  app.get('/', requireAuth(), async (c) => {
    if (!ownerEntityId) return c.json({ error: 'No owner entity configured' }, 404);
    const auth = c.get('auth')!;
    const record = await stack.asEntity(auth.entityId).get(ownerEntityId);
    if (!record) return c.json({ error: 'Entity record not found' }, 404);
    return c.json(serializeRecord(record));
  });

  app.patch('/', requireOwner(ownerEntityId), async (c) => {
    if (!ownerEntityId) return c.json({ error: 'No owner entity configured' }, 404);
    const auth = c.get('auth')!;
    const body = await c.req.json<Record<string, unknown>>();
    try {
      const updated = await stack
        .asEntity(auth.entityId)
        .update(ownerEntityId, (body.content ?? {}) as Record<string, unknown>);
      return c.json(serializeRecord(updated));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Record not found'))
        return c.json({ error: 'Entity record not found' }, 404);
      throw err;
    }
  });

  return app;
}
