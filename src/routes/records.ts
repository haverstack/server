import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { ScopedStack, TokenSession } from '@haverstack/core';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import {
  parseQueryBody,
  parseQueryParams,
  parsePositiveInt,
  parseIfMatch,
  createOptionsFromWireRecord,
} from '@haverstack/core/wire';
import { clampLimit } from '../lib/queryLimit.js';
import { serializeRecord, serializeVersion } from '@haverstack/wire-types';
import { StackValidationError, StackQueryError, StackNotFoundError } from '@haverstack/core';
import type { Association, Permission, TypeId } from '@haverstack/core';

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
    return auth ? stack.forSession(auth) : stack.asEntity(null);
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
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      // Always null: an unscoped count would leak how many Records exist
      // beyond what this requester may read. Set here rather than trusted
      // from result.total, so it holds whichever path produced the result.
      total: null,
    });
  });

  // GET /records — query by native fields via URL params
  app.get('/', async (c) => {
    const auth = c.get('auth');
    const query = clampLimit(parseQueryParams(new URL(c.req.url)));
    const result = await queryWorker.query(auth, query, queryTimeoutMs);
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      // Always null: an unscoped count would leak how many Records exist
      // beyond what this requester may read. Set here rather than trusted
      // from result.total, so it holds whichever path produced the result.
      total: null,
    });
  });

  // POST /records — a full record body, but version, entityId and
  // principalId are stamped here and never trusted from it. Everything else
  // a wire record body can carry — which fields are forwarded as-is, which
  // are owner-acting-alone-only, and which reduce to a boolean rather than
  // their literal value — is `createOptionsFromWireRecord()`'s disposition
  // to make, not this route's: see `@haverstack/core/wire` and
  // docs/spec/wire-format.md § Records.
  app.post('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const body = await readJson(c);
    const { typeId, content, options } = createOptionsFromWireRecord(body, auth, ownerEntityId);
    const created = await stack.forSession(auth).create(typeId, content, options);
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

  // PATCH /records/:id — the body IS the content patch (RFC 7396 merge
  // patch), never an envelope: a conforming client sends { "title": "New" }
  // directly, not { "content": { "title": "New" } }. Wrapping it here would
  // make every field the client sends invisible to Stack.update(), turning
  // a real edit into a silent no-op that still bumps version. null field
  // values remove the field.
  //
  // No route-level guard belongs here: ScopedStack owns the _attachment@1
  // immutable-field and _grant@1 owner-only rules (docs/spec/attachments.md,
  // docs/spec/access-control.md), so a denial round-trips as the core error
  // it is rather than a guess made before the permission check ran.
  app.patch('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const patch = await readJson<Record<string, unknown>>(c);

    const updated = await stack
      .forSession(auth)
      .update(id, patch, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord(updated));
  });

  // DELETE /records/:id  (?hard=true for permanent). A soft delete bumps
  // the version like any other mutation, so it answers with the record it
  // produced (carrying deletedAt); a hard delete leaves nothing to answer
  // with, so that one stays 204.
  app.delete('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const hard = new URL(c.req.url).searchParams.get('hard') === 'true';
    const session = stack.forSession(auth);

    await session.delete(id, { hard, ifVersion: parseIfMatch(c.req.header('If-Match')) });
    if (hard) return c.body(null, 204);
    return c.json(serializeRecord((await session.get(id))!));
  });

  // POST /records/:id/undelete — reverses a soft delete; idempotent
  app.post('/:id/undelete', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const restored = await stack
      .forSession(auth)
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

  app.put('/:id/permissions', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<{ permissions: Permission[] }>(c);
    if (!Array.isArray(body.permissions)) throw new StackQueryError('permissions must be an array');
    const updated = await stack.forSession(auth).setPermissions(id, body.permissions, {
      ifVersion: parseIfMatch(c.req.header('If-Match')),
    });
    return c.json(serializeRecord(updated));
  });

  // ------------------------------------------------------------------
  // Unlisted
  // ------------------------------------------------------------------

  // PUT /records/:id/unlisted — withhold from enumeration, or relist.
  // Orthogonal to permissions: decides whether the record is enumerable,
  // never who may read it. The owner-or-creator gate and the 409 on a
  // soft-deleted record both come from ScopedStack.setUnlisted().
  app.put('/:id/unlisted', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<{ unlisted: boolean }>(c);
    if (typeof body.unlisted !== 'boolean') throw new StackQueryError('unlisted must be a boolean');
    const updated = await stack.forSession(auth).setUnlisted(id, body.unlisted, {
      ifVersion: parseIfMatch(c.req.header('If-Match')),
    });
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

  app.post('/:id/associations', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<Association>(c);
    if (!body.kind || !body.label) throw new StackQueryError('kind and label are required');
    const updated = await stack
      .forSession(auth)
      .associate(id, body, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord(updated));
  });

  // POST, not DELETE — a DELETE request body has no defined semantics
  // (RFC 9110 §9.3.5) and is a portability landmine for proxies/gateways
  // that drop or reject it.
  app.post('/:id/associations/delete', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<Association>(c);
    const updated = await stack
      .forSession(auth)
      .dissociate(id, body, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord(updated));
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
      .forSession(auth)
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
      throw new StackQueryError('toTypeId is required');
    if (!body.content || typeof body.content !== 'object')
      throw new StackQueryError('content is required');
    if (!(await stack.getType(body.toTypeId as TypeId)))
      throw new StackValidationError([
        { path: 'toTypeId', message: `Unknown type: "${body.toTypeId}"` },
      ]);

    const migrated = await stack
      .forSession(auth)
      .commitMigration(id, body.toTypeId as TypeId, body.content as Record<string, unknown>, {
        ifVersion: parseIfMatch(c.req.header('If-Match')),
      });
    return c.json(serializeRecord(migrated));
  });

  return app;
}
