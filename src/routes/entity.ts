import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { serializeRecord } from '@haverstack/wire-types';
import { StackNotFoundError } from '@haverstack/core';

export function entityRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // `_entity@1` records get an auto-generated id — even the owner's own
  // card, whether hand-created or minted by Stack.create()'s ownerProfile
  // bootstrap. The binding lives in content.did, not the record id, so
  // finding it takes a query. Run unscoped: this only resolves *which*
  // record is the owner's card (routing, not data access) — the actual
  // read/write below still goes through the caller's session so
  // permission enforcement (403 for a known-but-forbidden record vs 404
  // for a genuinely missing one) is unchanged. See docs/spec/identity.md
  // § DID bindings.
  async function findOwnerRecordId(): Promise<string | null> {
    const result = await stack.query({
      filter: { typeId: '_entity@1', content: { did: ownerEntityId } },
      limit: 1,
    });
    return result.records[0]?.id ?? null;
  }

  app.get('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const id = await findOwnerRecordId();
    const record = id ? await stack.forSession(auth).get(id) : null;
    if (!record) throw new StackNotFoundError('Entity record not found');
    return c.json(serializeRecord(record));
  });

  app.patch('/', requireOwner(ownerEntityId), async (c) => {
    const auth = c.get('auth')!;
    const id = await findOwnerRecordId();
    if (!id) throw new StackNotFoundError('Entity record not found');
    const body = await c.req.json<Record<string, unknown>>();
    const updated = await stack
      .forSession(auth)
      .update(id, (body.content ?? {}) as Record<string, unknown>);
    return c.json(serializeRecord(updated));
  });

  return app;
}
