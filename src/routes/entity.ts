import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';
import { checkAccess } from '../lib/access.js';
import { serializeRecord, parseDate } from '../lib/serialize.js';

export function entityRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  app.get('/', requireAuth(), async (c) => {
    if (!ownerEntityId) return c.json({ error: 'No owner entity configured' }, 404);
    const record = await adapter.getRecord(ownerEntityId);
    if (!record) return c.json({ error: 'Entity record not found' }, 404);
    return c.json(serializeRecord(record));
  });

  app.patch('/', requireAuth(), async (c) => {
    if (!ownerEntityId) return c.json({ error: 'No owner entity configured' }, 404);
    const auth = c.get('auth')!;
    const existing = await adapter.getRecord(ownerEntityId);
    if (!existing) return c.json({ error: 'Entity record not found' }, 404);
    const canWrite = await checkAccess(existing, auth.entityId, ownerEntityId, 'write', adapter);
    if (!canWrite) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json<Record<string, unknown>>();

    await adapter.saveVersion(ownerEntityId, {
      version: existing.version,
      content: existing.content,
      updatedAt: existing.updatedAt,
      ...(existing.entityId && { entityId: existing.entityId }),
    });

    const updated = await adapter.updateRecord(ownerEntityId, {
      ...(body.content !== undefined && { content: body.content as Record<string, unknown> }),
      ...(body.typeId !== undefined && { typeId: body.typeId as string }),
      updatedAt: parseDate(body.updatedAt) ?? new Date(),
      version: typeof body.version === 'number' ? body.version : existing.version + 1,
    });

    return c.json(serializeRecord(updated));
  });

  return app;
}
