import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { parseDate, serializeType } from '../lib/serialize.js';
import { hashSchema } from '@haverstack/core';
import type { StackType, TypeSchema } from '@haverstack/core';

export function typeRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;

  app.get('/', async (c) => {
    const types = await adapter.listTypes();
    return c.json(types.map(serializeType));
  });

  app.get('/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const type = await adapter.getType(id);
    if (!type) return c.json({ error: 'Type not found' }, 404);
    return c.json(serializeType(type));
  });

  app.post('/', requireOwner(stack.ownerEntityId), async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body.id || typeof body.id !== 'string') return c.json({ error: 'id is required' }, 400);
    if (!body.baseId || typeof body.baseId !== 'string')
      return c.json({ error: 'baseId is required' }, 400);
    if (typeof body.version !== 'number') return c.json({ error: 'version must be a number' }, 400);
    if (!body.name || typeof body.name !== 'string')
      return c.json({ error: 'name is required' }, 400);
    if (!body.schema || typeof body.schema !== 'object')
      return c.json({ error: 'schema is required' }, 400);
    if (!body.schemaHash || typeof body.schemaHash !== 'string')
      return c.json({ error: 'schemaHash is required' }, 400);

    const computedHash = await hashSchema(body.schema as TypeSchema);
    if (body.schemaHash !== computedHash)
      return c.json({ error: 'schemaHash does not match schema' }, 400);

    const type: StackType = {
      id: body.id,
      baseId: body.baseId,
      version: body.version,
      name: body.name,
      schema: body.schema as TypeSchema,
      schemaHash: computedHash,
      createdAt: parseDate(body.createdAt) ?? new Date(),
      ...(body.migratesFrom ? { migratesFrom: body.migratesFrom as string } : {}),
    };

    await adapter.saveType(type);
    return c.json(serializeType(type), 201);
  });

  return app;
}
