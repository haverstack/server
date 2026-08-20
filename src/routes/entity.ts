import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
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
  //
  // The resolved id is cached: once minted, a record's own id never
  // changes, so re-querying for it on every GET is wasted work over the
  // life of the process. Not cached as "absent" — a null result is never
  // stored, so a card created later (ownerProfile wasn't configured at
  // boot, or the owner is created out of band) is picked up on the next
  // request rather than staying 404 forever. If a cached id ever stops
  // resolving (the card was deleted, or in principle recreated under a
  // new id), it's cleared so the next request re-resolves it — a
  // once-per-process query, not a permanent trust of a stale id.
  let cachedOwnerRecordId: string | null = null;

  async function resolveOwnerRecordId(): Promise<string | null> {
    if (cachedOwnerRecordId !== null) return cachedOwnerRecordId;
    const result = await stack.query({
      filter: { typeId: '_entity@1', content: { did: ownerEntityId } },
      limit: 1,
    });
    cachedOwnerRecordId = result.records[0]?.id ?? null;
    return cachedOwnerRecordId;
  }

  app.get('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const id = await resolveOwnerRecordId();
    const record = id ? await stack.forSession(auth).get(id) : null;
    if (!record) {
      cachedOwnerRecordId = null;
      throw new StackNotFoundError('Entity record not found');
    }
    return c.json(serializeRecord(record));
  });

  app.patch('/', requireOwner(ownerEntityId), async (c) => {
    const auth = c.get('auth')!;
    const id = await resolveOwnerRecordId();
    if (!id) throw new StackNotFoundError('Entity record not found');
    const body = await readJson<Record<string, unknown>>(c);
    let updated;
    try {
      updated = await stack
        .forSession(auth)
        .update(id, (body.content ?? {}) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof StackNotFoundError) cachedOwnerRecordId = null;
      throw err;
    }
    return c.json(serializeRecord(updated));
  });

  return app;
}
