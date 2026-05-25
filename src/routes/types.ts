import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';
import { serializeType } from '../lib/serialize.js';
import type { StackType, TypeSchema } from '@haverstack/core';

export function typeRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter } = ctx;

  // List all types
  app.get('/', requireAuth(), async (c) => {
    const types = await adapter.listTypes();
    return c.json(types.map(serializeType));
  });

  // Get one type (id is URL-encoded)
  app.get('/:id', requireAuth(), async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const type = await adapter.getType(id);
    if (!type) return c.json({ error: 'Type not found' }, 404);
    return c.json(serializeType(type));
  });

  // Register or replace a type
  app.post('/', requireAuth(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>();

    if (!body.id || typeof body.id !== 'string') {
      return c.json({ error: 'id is required' }, 400);
    }
    if (!body.baseId || typeof body.baseId !== 'string') {
      return c.json({ error: 'baseId is required' }, 400);
    }
    if (typeof body.version !== 'number') {
      return c.json({ error: 'version must be a number' }, 400);
    }
    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    if (!body.schema || typeof body.schema !== 'object') {
      return c.json({ error: 'schema is required' }, 400);
    }
    if (!body.schemaHash || typeof body.schemaHash !== 'string') {
      return c.json({ error: 'schemaHash is required' }, 400);
    }

    const type: StackType = {
      id: body.id,
      baseId: body.baseId,
      version: body.version,
      name: body.name,
      schema: body.schema as TypeSchema,
      schemaHash: body.schemaHash,
      createdAt: body.createdAt ? new Date(body.createdAt as string) : new Date(),
      ...(body.migratesFrom && { migratesFrom: body.migratesFrom as string }),
    };

    await adapter.saveType(type);
    return c.json(serializeType(type), 201);
  });

  return app;
}
