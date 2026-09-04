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

  // An `_entity@1` card binds its DID in content.did rather than in the
  // record id, so finding the owner's takes a query. It runs unscoped
  // because it resolves *which* record to touch, not its content: the read
  // or write below still goes through the caller's session. See
  // docs/spec/identity.md § DID bindings.
  //
  // A record's id never changes once minted, so the answer is cached. A
  // null is never cached, which is what lets a card created after boot be
  // picked up; a cached id that stops resolving is cleared below rather
  // than trusted onward.
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
      // A null from get() means "missing or unreadable" — the anti-oracle
      // rule — so only the owner's own null is evidence the card is gone.
      // Evicting on anyone else's denial would re-run the resolve query on
      // every forbidden GET for a card that never moved.
      const ownerActingAlone =
        auth.principalId === ownerEntityId && auth.subjectId === ownerEntityId;
      if (ownerActingAlone) cachedOwnerRecordId = null;
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
      // requireOwner() above already restricts this handler to the owner
      // acting alone, so unlike GET's, a StackNotFoundError here can only
      // mean the card is genuinely gone — never a permission denial.
      if (err instanceof StackNotFoundError) cachedOwnerRecordId = null;
      throw err;
    }
    return c.json(serializeRecord(updated));
  });

  return app;
}
