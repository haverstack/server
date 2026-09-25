import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { serializeType } from '@haverstack/wire-types';
import {
  hashSchema,
  StackBadRequestError,
  StackNotFoundError,
  StackValidationError,
} from '@haverstack/core';
import type { TypeSchema } from '@haverstack/core';

export function typeRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;

  app.get('/', knownParams(), async (c) => {
    const types = await adapter.listTypes();
    return c.json(types.map(serializeType));
  });

  app.get('/:id', knownParams(), async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const type = await adapter.getType(id);
    if (!type) throw new StackNotFoundError('Type not found');
    return c.json(serializeType(type));
  });

  app.post('/', knownParams(), requireOwner(stack.ownerEntityId), async (c) => {
    // The full StackType a client holds is accepted as-is: baseId, version
    // and createdAt are derived or stamped here, like a record's stamped
    // fields, so sending them back is not a mistake.
    const body = await readJson<Record<string, unknown>>(c, [
      'id',
      'baseId',
      'version',
      'name',
      'schema',
      'schemaHash',
      'migratesFrom',
      'createdAt',
    ]);
    if (!body.id || typeof body.id !== 'string') throw new StackBadRequestError('id is required');
    if (!body.name || typeof body.name !== 'string')
      throw new StackBadRequestError('name is required');
    if (!body.schema || typeof body.schema !== 'object')
      throw new StackBadRequestError('schema is required');
    if (!body.schemaHash || typeof body.schemaHash !== 'string')
      throw new StackBadRequestError('schemaHash is required');
    if (body.migratesFrom !== undefined && typeof body.migratesFrom !== 'string')
      throw new StackValidationError([{ path: 'migratesFrom', message: 'Must be a string' }]);

    const computedHash = await hashSchema(body.schema as TypeSchema);
    if (body.schemaHash !== computedHash)
      throw new StackValidationError([
        { path: 'schemaHash', message: 'schemaHash does not match schema' },
      ]);

    // stack.defineType() (not adapter.saveType() directly) is what runs the
    // schema-drift check: redefining an existing typeId with anything
    // beyond additive evolution throws StackSchemaDriftError, which
    // adapter.saveType() alone has no way to enforce — it's a raw write.
    const type = await stack.defineType({
      id: body.id,
      name: body.name,
      schema: body.schema as TypeSchema,
      ...(body.migratesFrom !== undefined && { migratesFrom: body.migratesFrom }),
    });
    return c.json(serializeType(type), 201);
  });

  return app;
}
