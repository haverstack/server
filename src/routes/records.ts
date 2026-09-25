import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { ScopedStack } from '@haverstack/core';
import type { TokenSession } from '@haverstack/core/wire';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import {
  parseQueryBody,
  parseQueryParams,
  parseJournalParams,
  parsePositiveInt,
  parseIfMatch,
  createOptionsFromWireRecord,
  changesFromWireBody,
} from '@haverstack/core/wire';
import { clampLimit, clampJournalLimit } from '../lib/queryLimit.js';
import { serializeRecord, serializeVersion, serializeJournalEntry } from '@haverstack/wire-types';
import type { WireQueryResponse, WireJournalResponse } from '@haverstack/wire-types';
import { StackValidationError, StackBadRequestError, StackNotFoundError } from '@haverstack/core';
import type { AuthorityAssociation, DataAssociation, TypeId } from '@haverstack/core';

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

// Only the routes that can search a large index (POST /query, GET /) run
// on the query worker pool with a deadline; everything else calls the main
// thread's ScopedStack directly, being index-bound already. Virtualizing
// the whole ScopedStack API across the worker boundary would buy no bound
// the unbounded-cost case needs. See src/lib/queryWorker/pool.ts and
// docs/spec/wire-format.md § Bounding query cost.
export function recordRoutes(ctx: StackContext, queryTimeoutMs: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack, queryWorker } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  /** Scope to a session if authenticated, else the anonymous view. */
  function scopeFor(auth: TokenSession | null): ScopedStack {
    return auth ? stack.asActor(auth) : stack.asEntity(null);
  }

  // POST /records/query — full query with content-field filters. Optional
  // auth, like GET /records: a superset of the same query surface, so an
  // anonymous caller gets the same public-record subset either way.
  // Registered ahead of the /:id patterns, which would otherwise capture
  // the literal "query" segment.
  app.post('/query', async (c) => {
    const auth = c.get('auth');
    const query = clampLimit(parseQueryBody(await readJson(c)));
    const result = await queryWorker.query(auth, query, queryTimeoutMs);
    const body: WireQueryResponse = {
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
    };
    return c.json(body);
  });

  // GET /records — query by native fields via URL params
  app.get('/', async (c) => {
    const auth = c.get('auth');
    const query = clampLimit(parseQueryParams(new URL(c.req.url)));
    const result = await queryWorker.query(auth, query, queryTimeoutMs);
    const body: WireQueryResponse = {
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
    };
    return c.json(body);
  });

  // POST /records — a full record body, but version, createdBy and
  // updatedBy are stamped here and never trusted from it. Everything else
  // a wire record body can carry — which fields are forwarded as-is, which
  // are owner-acting-alone-only, and which reduce to a boolean rather than
  // their literal value — is `createOptionsFromWireRecord()`'s disposition
  // to make, not this route's: see `@haverstack/core/wire` and
  // docs/spec/wire-format.md § Records.
  app.post('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const body = await readJson(c);
    const { typeId, content, options } = createOptionsFromWireRecord(body, auth, ownerEntityId);
    const created = await stack.asActor(auth).create(typeId, content, options);
    return c.json(serializeRecord(created), 200);
  });

  // GET /records/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const record = await scopeFor(auth).get(id);
    if (!record) throw new StackNotFoundError('Record not found');
    return c.json(serializeRecord(record));
  });

  // PATCH /records/:id — the body is a change set: an envelope naming any
  // combination of `contentPatch`, `parentId`, `permissions`, `associations`
  // and `unlisted`, applied as one atomic write that produces exactly one
  // version. A conforming client sends { "contentPatch": { "title": "New" } },
  // never the bare patch — content is one aspect among five here, so the
  // envelope is what tells a `parentId` naming a container from a content
  // field of that name. One If-Match fences the whole multi-aspect edit.
  //
  // `changesFromWireBody()` owns the entire read of that envelope: which
  // keys it may carry, the 400 an unrecognized or wholly absent key earns,
  // and the 422 a malformed value earns. Content keys stay Stack's to judge,
  // so nothing here inspects the patch. See docs/spec/wire-format.md § Records.
  //
  // No route-level guard belongs here: ScopedStack owns the _attachment@1
  // immutable-field and _grant@1 owner-only rules (docs/spec/attachments.md,
  // docs/spec/access-control.md) and resolves each change-set key against its
  // own gate, so a denial round-trips as the core error it is rather than a
  // guess made before the permission check ran.
  app.patch('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const changes = changesFromWireBody(await readJson(c));

    const updated = await stack
      .asActor(auth)
      .mutate(id, changes, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord(updated));
  });

  // DELETE /records/:id  (?purge=true for permanent). Both answer 200 with
  // a record: a soft delete with the tombstone it produced, a purge
  // with the record as it stood immediately before destruction. That body
  // is the requester's only report of the files the purge stranded; every
  // other row naming them is gone by the time it lands. deleteAndReturn()
  // captures it inside the same write that destroys or tombstones the
  // record, so there is no read-then-delete window for a concurrent write
  // to fall into. See docs/spec/wire-format.md § Records and
  // docs/spec/attachments.md § A purge strands the bytes it referenced.
  app.delete('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const purge = new URL(c.req.url).searchParams.get('purge') === 'true';
    const session = stack.asActor(auth);

    const { record } = await session.deleteAndReturn(id, {
      purge,
      ifVersion: parseIfMatch(c.req.header('If-Match')),
    });
    if (!record) throw new StackNotFoundError('Record not found');
    return c.json(serializeRecord(record));
  });

  // POST /records/:id/undelete — reverses a soft delete; idempotent
  app.post('/:id/undelete', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const restored = await stack
      .asActor(auth)
      .undelete(id, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord(restored));
  });

  // ------------------------------------------------------------------
  // Permissions
  // ------------------------------------------------------------------

  app.get('/:id/permissions', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const record = await scopeFor(auth).get(id);
    if (!record) throw new StackNotFoundError('Record not found');
    return c.json({ permissions: record.permissions ?? [] });
  });

  // The amending spelling, where the change set's `permissions` key
  // replaces the whole set — which is what survives two admins sharing one
  // record at once. Both carry the reshare gate rather than the write bit,
  // and both are ScopedStack's to apply: it refuses a data kind sent to
  // this surface and holds the set to `write` implying `read`, so nothing
  // here inspects the body. See docs/spec/access-control.md
  // § Record-level permissions.
  app.post('/:id/permissions', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<AuthorityAssociation>(c);
    const updated = await stack.asActor(auth).grantAccess(id, body);
    return c.json(serializeRecord(updated));
  });

  // POST to a /delete sub-path for the reason the association endpoints
  // use one, below.
  app.post('/:id/permissions/delete', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<AuthorityAssociation>(c);
    const updated = await stack.asActor(auth).revokeAccess(id, body);
    return c.json(serializeRecord(updated));
  });

  // ------------------------------------------------------------------
  // Associations
  // ------------------------------------------------------------------

  app.get('/:id/associations', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const record = await scopeFor(auth).get(id);
    if (!record) throw new StackNotFoundError('Record not found');
    let assocs = record.associations ?? [];
    const kind = c.req.query('kind');
    if (kind) assocs = assocs.filter((a) => a.kind === kind);
    const label = c.req.query('label');
    if (label) assocs = assocs.filter((a) => a.label === label);
    return c.json({ associations: assocs });
  });

  // Neither mutating endpoint reads If-Match, and one sent to either is
  // ignored rather than refused: a set add/remove composes whatever the
  // write order, so there is no race for a precondition to fence. Both
  // answer with a record carrying whatever version it already had. See
  // docs/spec/wire-format.md § Associations.
  app.post('/:id/associations', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<DataAssociation>(c);
    if (!body.kind || !body.label) throw new StackBadRequestError('kind and label are required');
    const updated = await stack.asActor(auth).associate(id, body);
    return c.json(serializeRecord(updated));
  });

  // POST, not DELETE — a DELETE request body has no defined semantics
  // (RFC 9110 §9.3.5) and is a portability landmine for proxies/gateways
  // that drop or reject it.
  app.post('/:id/associations/delete', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<DataAssociation>(c);
    const updated = await stack.asActor(auth).dissociate(id, body);
    return c.json(serializeRecord(updated));
  });

  // ------------------------------------------------------------------
  // Journal
  // ------------------------------------------------------------------

  // GET /records/:id/journal — the change journal, oldest first. Not
  // optional and never answered empty for a record this server doesn't
  // hold: an empty log means "nothing changed" unconditionally, so a
  // missing or purged record is the 404 ScopedStack raises.
  //
  // The mutate-surface gate and the authority-element projection a
  // non-resharer gets are both ScopedStack.getJournal()'s, so this route
  // decodes the window, bounds the page and serializes. `cursor` is the
  // only end-of-log signal — a page filled to the ceiling carries the seq
  // to resume from, whether or not the log ends there. See
  // docs/spec/journal.md and docs/spec/wire-format.md § Journal.
  app.get('/:id/journal', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const query = parseJournalParams(new URL(c.req.url));
    const limit = clampJournalLimit(query.limit);

    const entries = await scopeFor(auth).getJournal(id, { ...query, limit });
    const body: WireJournalResponse = {
      entries: entries.map(serializeJournalEntry),
      cursor:
        entries.length > 0 && entries.length === limit ? entries[entries.length - 1]!.seq : null,
    };
    return c.json(body);
  });

  // ------------------------------------------------------------------
  // Versions
  // ------------------------------------------------------------------

  app.get('/:id/versions', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const versions = await scopeFor(auth).getVersions(id);
    return c.json(versions.map(serializeVersion));
  });

  app.get('/:id/versions/:version', async (c) => {
    const id = c.req.param('id');
    const vNum = parsePositiveInt(c.req.param('version'), 'version number');
    const auth = c.get('auth');
    const version = await scopeFor(auth).getVersion(id, vNum);
    if (!version) throw new StackNotFoundError('Version not found');
    return c.json(serializeVersion(version));
  });

  // POST /records/:id/restore/:version — creates new version, does not rewrite history
  app.post('/:id/restore/:version', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const vNum = parsePositiveInt(c.req.param('version'), 'version number');
    const auth = c.get('auth')!;
    const restored = await stack
      .asActor(auth)
      .restoreVersion(id, vNum, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord(restored));
  });

  // POST /records/:id/migrate — the only way typeId changes after creation.
  // The body carries the full post-migration content, computed client-side
  // by the type's owning app and validated against toTypeId's schema by
  // ScopedStack.commitMigration(). Owner acting alone only: replacing
  // content and typeId wholesale would have to re-derive every gate
  // create() and update() apply at both ends.
  app.post('/:id/migrate', requireOwner(ownerEntityId), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<Record<string, unknown>>(c);
    if (!body.toTypeId || typeof body.toTypeId !== 'string')
      throw new StackBadRequestError('toTypeId is required');
    if (!body.content || typeof body.content !== 'object')
      throw new StackBadRequestError('content is required');
    if (!(await stack.getType(body.toTypeId as TypeId)))
      throw new StackValidationError([
        { path: 'toTypeId', message: `Unknown type: "${body.toTypeId}"` },
      ]);

    const migrated = await stack
      .asActor(auth)
      .commitMigration(id, body.toTypeId as TypeId, body.content as Record<string, unknown>, {
        ifVersion: parseIfMatch(c.req.header('If-Match')),
      });
    return c.json(serializeRecord(migrated));
  });

  return app;
}
