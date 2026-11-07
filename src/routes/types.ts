import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import { requireAuth } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { serializeType } from '@haverstack/wire-types';
import { parseTypeBody } from '@haverstack/core/wire';
import { StackNotFoundError } from '@haverstack/core';

export function typeRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Open to every requester: a client needs a schema to read the records it
  // reaches, and ScopedStack asks nothing here. See docs/spec/wire-format.md § Types.
  app.get('/', knownParams(), async (c) => {
    const types = await c.get('scope').listTypes();
    return c.json(types.map(serializeType));
  });

  app.get('/:id', knownParams(), async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const type = await c.get('scope').getType(id);
    if (!type) throw new StackNotFoundError('Type not found');
    return c.json(serializeType(type));
  });

  // ScopedStack.defineType() refuses all but the owner acting alone, and
  // runs the schema-drift check. See docs/spec/wire-format.md § Types.
  app.post('/', knownParams(), requireAuth(), async (c) => {
    const type = await c.get('scope').defineType(parseTypeBody(await readJson(c)));
    return c.json(serializeType(type), 201);
  });

  return app;
}
