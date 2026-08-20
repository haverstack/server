import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { parseDate } from '@haverstack/wire-types';
import { StackValidationError } from '@haverstack/core';
import { isValidDid } from '@haverstack/core/did';
import type { TokenInfo } from '@haverstack/core/wire';

export function tokenRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { tokens, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // POST /tokens — issue a new token (owner only). `onBehalfOf` asserts a
  // delegation out of band: the owner names the subject the issued
  // principal acts for, per docs/spec/wire-format.md § The session a
  // token names.
  app.post('/', requireOwner(ownerEntityId), async (c) => {
    const body = await readJson<{
      entityId?: string;
      onBehalfOf?: string;
      label?: string;
      expiresAt?: string;
    }>(c);
    if (body.entityId !== undefined && !isValidDid(body.entityId))
      throw new StackValidationError([{ path: 'entityId', message: 'Must be a DID' }]);
    if (body.onBehalfOf !== undefined && !isValidDid(body.onBehalfOf))
      throw new StackValidationError([{ path: 'onBehalfOf', message: 'Must be a DID' }]);

    const principalId = body.entityId ?? ownerEntityId;
    const expiresAt = body.expiresAt ? parseDate(body.expiresAt) : undefined;
    if (body.expiresAt && !expiresAt)
      throw new StackValidationError([{ path: 'expiresAt', message: 'Invalid date' }]);

    const { id, token } = await tokens.createToken(principalId, {
      onBehalfOf: body.onBehalfOf,
      label: body.label,
      expiresAt,
    });

    // Read the row back rather than fabricating createdAt here — the store
    // is the source of truth, and GET /tokens must report the same value.
    const stored = (await tokens.listTokens()).find((t) => t.id === id)!;

    return c.json(
      {
        id,
        token,
        principalId,
        subjectId: body.onBehalfOf ?? principalId,
        label: stored.label ?? null,
        createdAt: stored.createdAt.toISOString(),
        expiresAt: stored.expiresAt?.toISOString() ?? null,
      },
      201,
    );
  });

  // GET /tokens — list all DB-managed tokens; never returns token values
  app.get('/', requireOwner(ownerEntityId), async (c) => {
    const list = await tokens.listTokens();
    return c.json({ tokens: list.map(serializeToken) });
  });

  // DELETE /tokens/:id — revoke a token by its ID
  app.delete('/:id', requireOwner(ownerEntityId), async (c) => {
    await tokens.revokeToken(c.req.param('id'));
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
