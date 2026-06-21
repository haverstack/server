import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { parseDate } from '../lib/serialize.js';
import type { TokenInfo } from '@haverstack/adapter-sqlite';

export function tokenRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // POST /tokens — issue a new token (owner only)
  app.post('/', requireOwner(ownerEntityId), async (c) => {
    const body = await c.req.json<{ entityId?: string; label?: string; expiresAt?: string }>();
    const entityId = body.entityId ?? ownerEntityId!;
    const expiresAt = body.expiresAt ? parseDate(body.expiresAt) : undefined;
    if (body.expiresAt && !expiresAt) return c.json({ error: 'Invalid expiresAt date' }, 422);

    const { id, token } = await adapter.createToken(entityId, { label: body.label, expiresAt });

    return c.json(
      {
        id,
        token,
        entityId,
        label: body.label ?? null,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt?.toISOString() ?? null,
      },
      201,
    );
  });

  // GET /tokens — list all DB-managed tokens; never returns token values
  app.get('/', requireOwner(ownerEntityId), async (c) => {
    const tokens = await adapter.listTokens();
    return c.json({ tokens: tokens.map(serializeToken) });
  });

  // DELETE /tokens/:id — revoke a token by its ID
  app.delete('/:id', requireOwner(ownerEntityId), async (c) => {
    await adapter.revokeToken(c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}

function serializeToken(t: TokenInfo) {
  return {
    id: t.id,
    entityId: t.entityId,
    label: t.label ?? null,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null,
  };
}
