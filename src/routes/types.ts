import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { serializeType } from '@haverstack/wire-types';
import {
  hashSchema,
  StackQueryError,
  StackNotFoundError,
  StackValidationError,
} from '@haverstack/core';
import type { TypeSchema } from '@haverstack/core';

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
    const body = await readJson<Record<string, unknown>>(c);
    if (!body.id || typeof body.id !== 'string') throw new StackQueryError('id is required');
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

    // stack.defineType() (not adapter.saveType() directly) is what runs the
    // schema-drift check: redefining an existing typeId with anything
    // beyond additive evolution throws StackSchemaDriftError, which
    // adapter.saveType() alone has no way to enforce — it's a raw write.
    const type = await stack.defineType(body.id, body.name, body.schema as TypeSchema, {
      ...(body.migratesFrom ? { migratesFrom: body.migratesFrom as string } : {}),
    });
    return c.json(serializeType(type), 201);
  });

  return app;
}
