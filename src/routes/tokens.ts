import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { parseDate } from '@haverstack/wire-types';
import { StackValidationError } from '@haverstack/core';
import type { TokenInfo } from '@haverstack/adapter-local';

export function tokenRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // POST /tokens — issue a new token (owner only). `onBehalfOf` asserts a
  // delegation out of band: the owner names the subject the issued
  // principal acts for, per docs/spec/wire-format.md § The session a
  // token names.
  app.post('/', requireOwner(ownerEntityId), async (c) => {
    const body = await c.req.json<{
      entityId?: string;
      onBehalfOf?: string;
      label?: string;
      expiresAt?: string;
    }>();
    const principalId = body.entityId ?? ownerEntityId;
    const expiresAt = body.expiresAt ? parseDate(body.expiresAt) : undefined;
    if (body.expiresAt && !expiresAt)
      throw new StackValidationError([{ path: 'expiresAt', message: 'Invalid date' }]);

    const { id, token } = await adapter.createToken(principalId, {
      onBehalfOf: body.onBehalfOf,
      label: body.label,
      expiresAt,
    });

    return c.json(
      {
        id,
        token,
        principalId,
        subjectId: body.onBehalfOf ?? principalId,
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
    principalId: t.principalId,
    subjectId: t.subjectId,
    label: t.label ?? null,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null,
  };
}
