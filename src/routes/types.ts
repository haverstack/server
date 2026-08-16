import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { parseDate, serializeType } from '@haverstack/wire-types';
import {
  hashSchema,
  StackQueryError,
  StackNotFoundError,
  StackValidationError,
} from '@haverstack/core';
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
    if (!type) throw new StackNotFoundError('Type not found');
    return c.json(serializeType(type));
  });

  app.post('/', requireOwner(stack.ownerEntityId), async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    if (!body.id || typeof body.id !== 'string') throw new StackQueryError('id is required');
    if (!body.baseId || typeof body.baseId !== 'string')
      throw new StackQueryError('baseId is required');
    if (typeof body.version !== 'number') throw new StackQueryError('version must be a number');
    if (!body.name || typeof body.name !== 'string') throw new StackQueryError('name is required');
    if (!body.schema || typeof body.schema !== 'object')
      throw new StackQueryError('schema is required');
    if (!body.schemaHash || typeof body.schemaHash !== 'string')
      throw new StackQueryError('schemaHash is required');

    const computedHash = await hashSchema(body.schema as TypeSchema);
    if (body.schemaHash !== computedHash)
      throw new StackValidationError([
        { path: 'schemaHash', message: 'schemaHash does not match schema' },
      ]);

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
