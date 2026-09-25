import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
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

  // POST /tokens — issue a new token (owner only). The body names an Actor:
  // `principalId` is the identity the token authenticates as (default: the
  // owner), and `subjectId` asserts a delegation out of band — the subject
  // that principal acts for (default: the principal itself), per
  // docs/spec/wire-format.md § The session a token names.
  app.post('/', knownParams(), requireOwner(ownerEntityId), async (c) => {
    const body = await readJson<{
      principalId?: string;
      subjectId?: string;
      label?: string;
      expiresAt?: string;
    }>(c, ['principalId', 'subjectId', 'label', 'expiresAt']);
    if (body.principalId !== undefined && !isValidDid(body.principalId))
      throw new StackValidationError([{ path: 'principalId', message: 'Must be a DID' }]);
    if (body.subjectId !== undefined && !isValidDid(body.subjectId))
      throw new StackValidationError([{ path: 'subjectId', message: 'Must be a DID' }]);

    const principalId = body.principalId ?? ownerEntityId;
    const subjectId = body.subjectId ?? principalId;
    if (body.label !== undefined && typeof body.label !== 'string')
      throw new StackValidationError([{ path: 'label', message: 'Must be a string' }]);
    const expiresAt = typeof body.expiresAt === 'string' ? parseDate(body.expiresAt) : undefined;
    if (body.expiresAt !== undefined && !expiresAt)
      throw new StackValidationError([{ path: 'expiresAt', message: 'Invalid date' }]);

    const { id, token } = await tokens.createToken(
      { subjectId, principalId },
      {
        label: body.label,
        expiresAt,
      },
    );

    // Read the row back rather than fabricating createdAt here — the store
    // is the source of truth, and GET /tokens must report the same value.
    const stored = (await tokens.listTokens()).find((t) => t.id === id)!;

    return c.json(
      {
        id,
        token,
        principalId,
        subjectId,
        label: stored.label ?? null,
        createdAt: stored.createdAt.toISOString(),
        expiresAt: stored.expiresAt?.toISOString() ?? null,
      },
      201,
    );
  });

  // GET /tokens — list all DB-managed tokens; never returns token values
  app.get('/', knownParams(), requireOwner(ownerEntityId), async (c) => {
    const list = await tokens.listTokens();
    return c.json({ tokens: list.map(serializeToken) });
  });

  // DELETE /tokens/:id — revoke a token by its ID
  app.delete('/:id', knownParams(), requireOwner(ownerEntityId), async (c) => {
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
