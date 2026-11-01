import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import type { ScopedStack } from '@haverstack/core';
import type { TokenSession } from '@haverstack/core/wire';
import { requireAuth } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import {
  parseQueryBody,
  parseQueryParams,
  parseGetRecordParams,
  parseDeleteParams,
  parseJournalParams,
  parseVersionsParams,
  parseAssociationParams,
  parseUnsignedInt,
  createOptionsFromWireRecord,
  parseContentPatchBody,
  parseParentBody,
  parseUnlistedBody,
  parseAssociationEditsBody,
  parseAssociationsBody,
  parsePermissionsBody,
  parseMigrationBody,
} from '@haverstack/core/wire';
import { readHistoryPage } from '../lib/historyPage.js';
import { ifMatchVersion } from '../lib/ifMatch.js';
import { serializeRecord, serializeVersion, serializeJournalEntry } from '@haverstack/wire-types';
import type {
  WireQueryResponse,
  WireJournalResponse,
  WireVersionsResponse,
} from '@haverstack/wire-types';
import { StackNotFoundError } from '@haverstack/core';

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
  app.post('/query', knownParams(), async (c) => {
    const auth = c.get('auth');
    const query = parseQueryBody(await readJson(c));
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
    const query = parseQueryParams(new URL(c.req.url));
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
  app.post('/', knownParams(), requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const body = await readJson(c);
    const { typeId, content, options } = createOptionsFromWireRecord(body, auth, ownerEntityId);
    const created = await stack.asActor(auth).create(typeId, content, options);
    return c.json(serializeRecord(created), 200);
  });

  // GET /records/:id — a tombstone answers 404 unless ?includeDeleted=true,
  // as on GET /records. See docs/spec/wire-format.md § Records.
  app.get('/:id', async (c) => {
    const opts = parseGetRecordParams(new URL(c.req.url));
    const record = await scopeFor(c.get('auth')).get(c.req.param('id'), opts);
    if (!record) throw new StackNotFoundError('Record not found');
    return c.json(serializeRecord(record));
  });

  // Every aspect of a record has one write endpoint, and each endpoint
  // reads If-Match and answers with the record it produced. Which gate a
  // write passes — write, reshare, the _attachment@1 immutable fields, the
  // _grant@1 owner-only rule — is ScopedStack's to resolve, so a denial
  // round-trips as the core error it is rather than a guess made here.
  // See docs/spec/wire-format.md § Records and § Optimistic concurrency.
  app.patch('/:id/content', knownParams(), requireAuth(), async (c) => {
    const patch = parseContentPatchBody(await readJson(c));
    const updated = await stack
      .asActor(c.get('auth')!)
      .patchContent(c.req.param('id'), patch, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  app.put('/:id/parent', knownParams(), requireAuth(), async (c) => {
    const { parentId } = parseParentBody(await readJson(c));
    const updated = await stack
      .asActor(c.get('auth')!)
      .setParent(c.req.param('id'), parentId, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  app.put('/:id/unlisted', knownParams(), requireAuth(), async (c) => {
    const { unlisted } = parseUnlistedBody(await readJson(c));
    const updated = await stack
      .asActor(c.get('auth')!)
      .setUnlisted(c.req.param('id'), unlisted, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  // DELETE /records/:id  (?purge=true for permanent). Both answer 200 with
  // a record: a soft delete with the tombstone it produced, a purge with
  // the record as it stood immediately before destruction. That body is
  // the requester's only report of the files the purge stranded, and
  // delete() captures it inside the same write that destroys the record.
  // See docs/spec/attachments.md § A purge strands the bytes it referenced.
  app.delete('/:id', requireAuth(), async (c) => {
    const { purge } = parseDeleteParams(new URL(c.req.url));
    const { record } = await stack
      .asActor(c.get('auth')!)
      .delete(c.req.param('id'), { purge, ...ifMatchVersion(c) });
    if (!record) throw new StackNotFoundError('Record not found');
    return c.json(serializeRecord(record));
  });

  // POST /records/:id/undelete — reverses a soft delete; idempotent
  app.post('/:id/undelete', knownParams(), requireAuth(), async (c) => {
    const restored = await stack
      .asActor(c.get('auth')!)
      .undelete(c.req.param('id'), ifMatchVersion(c));
    return c.json(serializeRecord(restored));
  });

  // ------------------------------------------------------------------
  // Permissions and associations
  // ------------------------------------------------------------------

  // Two surfaces, one shape: a POST edits the set with a list of adds and
  // removes applied as one write, and a PUT replaces it. An element sent to
  // the wrong surface is ScopedStack's 400, so nothing here inspects one.
  // See docs/spec/wire-format.md § Permissions and § Associations.

  app.get('/:id/permissions', knownParams(), async (c) => {
    const record = await scopeFor(c.get('auth')).get(c.req.param('id'));
    if (!record) throw new StackNotFoundError('Record not found');
    return c.json({ permissions: record.permissions ?? [] });
  });

  app.post('/:id/permissions', knownParams(), requireAuth(), async (c) => {
    const edits = parseAssociationEditsBody(await readJson(c));
    const updated = await stack
      .asActor(c.get('auth')!)
      .editAccess(c.req.param('id'), edits, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  app.put('/:id/permissions', knownParams(), requireAuth(), async (c) => {
    const permissions = parsePermissionsBody(await readJson(c));
    const updated = await stack
      .asActor(c.get('auth')!)
      .setAccess(c.req.param('id'), permissions, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  app.get('/:id/associations', async (c) => {
    const { kind, label } = parseAssociationParams(new URL(c.req.url));
    const record = await scopeFor(c.get('auth')).get(c.req.param('id'));
    if (!record) throw new StackNotFoundError('Record not found');
    const associations = (record.associations ?? []).filter(
      (a) => (kind === undefined || a.kind === kind) && (label === undefined || a.label === label),
    );
    return c.json({ associations });
  });

  app.post('/:id/associations', knownParams(), requireAuth(), async (c) => {
    const edits = parseAssociationEditsBody(await readJson(c));
    const updated = await stack
      .asActor(c.get('auth')!)
      .editAssociations(c.req.param('id'), edits, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  app.put('/:id/associations', knownParams(), requireAuth(), async (c) => {
    const associations = parseAssociationsBody(await readJson(c));
    const updated = await stack
      .asActor(c.get('auth')!)
      .setAssociations(c.req.param('id'), associations, ifMatchVersion(c));
    return c.json(serializeRecord(updated));
  });

  // ------------------------------------------------------------------
  // Journal
  // ------------------------------------------------------------------

  // GET /records/:id/journal — the change journal, oldest first. Never
  // answered empty for a record this server doesn't hold: an empty log
  // means "nothing changed" unconditionally, so a missing or purged record
  // is the 404 ScopedStack raises. The mutate-surface gate and the
  // authority-element projection are both ScopedStack.getJournal()'s.
  // See docs/spec/journal.md and docs/spec/wire-format.md § Journal.
  app.get('/:id/journal', async (c) => {
    const id = c.req.param('id');
    const query = parseJournalParams(new URL(c.req.url));
    const scoped = scopeFor(c.get('auth'));
    const { rows, cursor } = await readHistoryPage(
      query.limit,
      (limit) => scoped.getJournal(id, { ...query, limit }),
      (entry) => entry.seq,
    );
    const body: WireJournalResponse = { entries: rows.map(serializeJournalEntry), cursor };
    return c.json(body);
  });

  // ------------------------------------------------------------------
  // Versions
  // ------------------------------------------------------------------

  // Newest first, paged like the journal. See docs/spec/wire-format.md § Versions.
  app.get('/:id/versions', async (c) => {
    const id = c.req.param('id');
    const query = parseVersionsParams(new URL(c.req.url));
    const scoped = scopeFor(c.get('auth'));
    const { rows, cursor } = await readHistoryPage(
      query.limit,
      (limit) => scoped.getVersions(id, { ...query, limit }),
      (version) => version.version,
    );
    const body: WireVersionsResponse = { versions: rows.map(serializeVersion), cursor };
    return c.json(body);
  });

  app.get('/:id/versions/:version', knownParams(), async (c) => {
    const version = await scopeFor(c.get('auth')).getVersion(
      c.req.param('id'),
      parseUnsignedInt(c.req.param('version'), 'version number'),
    );
    if (!version) throw new StackNotFoundError('Version not found');
    return c.json(serializeVersion(version));
  });

  // POST /records/:id/restore/:version — creates new version, does not rewrite history
  app.post('/:id/restore/:version', knownParams(), requireAuth(), async (c) => {
    const restored = await stack
      .asActor(c.get('auth')!)
      .restoreVersion(
        c.req.param('id'),
        parseUnsignedInt(c.req.param('version'), 'version number'),
        ifMatchVersion(c),
      );
    return c.json(serializeRecord(restored));
  });

  // POST /records/:id/migrate — the only way typeId changes after creation.
  // The body carries the full post-migration content, computed by the
  // type's owning app. Who may commit one — the owner, or an installed app
  // within the families its install claims — is ScopedStack's to decide.
  // See docs/spec/wire-format.md § Migration commit.
  app.post('/:id/migrate', knownParams(), requireAuth(), async (c) => {
    const { toTypeId, content } = parseMigrationBody(await readJson(c));
    const migrated = await stack
      .asActor(c.get('auth')!)
      .commitMigration(c.req.param('id'), toTypeId, content, ifMatchVersion(c));
    return c.json(serializeRecord(migrated));
  });

  return app;
}
