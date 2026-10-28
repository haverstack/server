import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { serializeType } from '@haverstack/wire-types';
import { parseTypeBody } from '@haverstack/core/wire';
import { StackNotFoundError } from '@haverstack/core';

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

  // Served through the unscoped Stack: ScopedStack has no defineType(), and
  // no grant confers defining a stack-wide Type. stack.defineType() rather
  // than adapter.saveType() is what runs the schema-drift check.
  // See docs/spec/wire-format.md § Types.
  app.post('/', knownParams(), requireOwner(stack.ownerEntityId), async (c) => {
    const type = await stack.defineType(parseTypeBody(await readJson(c)));
    return c.json(serializeType(type), 201);
  });

  return app;
}
