import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { ScopedStack, TokenSession } from '@haverstack/core';
import { requireAuth, requireOwner, isOwnerActingAlone } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { parseQueryBody, parseQueryParams, parsePositiveInt } from '../lib/queryParsing.js';
import { serializeRecord, serializeVersion } from '@haverstack/wire-types';
import { StackValidationError, StackQueryError, StackNotFoundError } from '@haverstack/core';
import type { Association, Permission, TypeId } from '@haverstack/core';

/** Parse an `If-Match: "5"` header into the version number for `ifVersion`. */
function parseIfMatch(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const n = parseInt(header.replace(/^"|"$/g, ''), 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Parse a body field into a Date for the owner-only backdating options
 * (`createdAt`/`updatedAt`). An `Invalid Date` must not reach `create()` as
 * one — core refuses it outright rather than storing it, since its `NaN`
 * timestamp would switch off the skew checks instead of failing them, but a
 * malformed string is better reported here as a validation error.
 */
function parseOwnerDate(value: unknown, path: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new StackValidationError([{ path, message: `${path} must be a date string` }]);
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new StackValidationError([
      { path, message: `Invalid ${path}: ${JSON.stringify(value)}` },
    ]);
  }
  return date;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

// Routes that can search a large index (POST /query, GET /) run through
// the query worker pool with a deadline (docs/spec/wire-format.md §
// Bounding query cost); every other route below still calls the main
// thread's Stack/ScopedStack directly. Only full-text/content-field
// search over a large store has unbounded cost — a get, create, or
// patch by id is index-bound and already fast, and routing every Stack
// call through the worker boundary would mean virtualizing the entire
// ScopedStack API (including attachment byte streaming) for no bound
// this issue is actually about. See src/lib/queryWorker/pool.ts.
export function recordRoutes(ctx: StackContext, queryTimeoutMs: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack, queryWorker } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  /** Scope to a session if authenticated, else the anonymous view. */
  function scopeFor(auth: TokenSession | null): ScopedStack {
    return auth ? stack.forSession(auth) : stack.asEntity(null);
  }

  // POST /records/query — full query with content-field filters. Optional
  // auth, same as GET /records: it's a superset of the same query surface,
  // so an anonymous caller gets the same public-record subset either way
  // (docs/api.md lists both as Optional). See #49.
  // Registered before /:id patterns to avoid param capture on the literal "query" segment.
  app.post('/query', async (c) => {
    const auth = c.get('auth');
    const query = parseQueryBody(await readJson(c));
    const result = await queryWorker.query(auth, query, queryTimeoutMs);
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      // Always null over the wire: every response has passed a permission
      // boundary, so an unscoped count would leak how many Records exist
      // beyond what this requester may read. Set explicitly here rather
      // than trusting result.total, so the guarantee holds regardless of
      // which query path produced the result.
      total: null,
    });
  });

  // GET /records — query by native fields via URL params
  app.get('/', async (c) => {
    const auth = c.get('auth');
    const query = parseQueryParams(new URL(c.req.url));
    const result = await queryWorker.query(auth, query, queryTimeoutMs);
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      // Always null over the wire: every response has passed a permission
      // boundary, so an unscoped count would leak how many Records exist
      // beyond what this requester may read. Set explicitly here rather
      // than trusting result.total, so the guarantee holds regardless of
      // which query path produced the result.
      total: null,
    });
  });

  // POST /records — accepts a full record body; id is client-minted (12
  // lowercase Crockford base-32 chars, no reserved "_" prefix) and optional
  // — omit it to let ScopedStack.create() generate one. version is never
  // accepted from the client: it's always freshly generated for a new
  // record, same as entityId/principalId (stamped from the authenticated
  // session, never trusted from the body). createdAt/updatedAt are accepted
  // only from the stack owner acting alone — everyone else's client sends
  // both on every create (a record body is a whole record, and adapter-api
  // serializes it with Dates included), and forwarding them unfiltered
  // would turn an ordinary grantee create into a 403: ScopedStack.create()
  // refuses backdating outright rather than ignoring it. See #99.
  app.post('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const body = await readJson<Record<string, unknown>>(c);
    if (!body.typeId || typeof body.typeId !== 'string')
      throw new StackQueryError('typeId is required');
    if (!body.content || typeof body.content !== 'object')
      throw new StackQueryError('content is required');

    const ownerActingAlone = isOwnerActingAlone(auth, ownerEntityId);
    const createdAt = ownerActingAlone ? parseOwnerDate(body.createdAt, 'createdAt') : undefined;
    const updatedAt = ownerActingAlone ? parseOwnerDate(body.updatedAt, 'updatedAt') : undefined;

    const created = await stack
      .forSession(auth)
      .create(body.typeId as TypeId, body.content as Record<string, unknown>, {
        id: typeof body.id === 'string' ? body.id : undefined,
        parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
        appId: typeof body.appId === 'string' ? body.appId : undefined,
        permissions: Array.isArray(body.permissions)
          ? (body.permissions as Permission[])
          : undefined,
        associations: Array.isArray(body.associations)
          ? (body.associations as Association[])
          : undefined,
        createdAt,
        updatedAt,
      });
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
  // The _attachment@1 immutable-field guard, the _grant@1 owner-only guard,
  // and the unscoped stack.get() pre-fetch that used to back them are gone:
  // ScopedStack now enforces all of it (docs/spec/attachments.md,
  // docs/spec/access-control.md), so a denial round-trips as the core error
  // it actually is instead of a route-level guess made before the
  // permission check ever ran.
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
    const session = stack.forSession(auth);
    await session.setPermissions(id, body.permissions, {
      ifVersion: parseIfMatch(c.req.header('If-Match')),
    });
    return c.json(serializeRecord((await session.get(id))!));
  });

  // ------------------------------------------------------------------
  // Unlisted
  // ------------------------------------------------------------------

  // PUT /records/:id/unlisted — withhold from enumeration, or relist.
  // Orthogonal to permissions: decides whether the record is enumerable,
  // never who may read it. Gated exactly like setPermissions() (owner or
  // creator) and refused on a soft-deleted record with 409 — both come
  // free from ScopedStack.setUnlisted(), which (like associate/dissociate)
  // returns void rather than the record, so the response is a re-fetch.
  app.put('/:id/unlisted', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<{ unlisted: boolean }>(c);
    if (typeof body.unlisted !== 'boolean') throw new StackQueryError('unlisted must be a boolean');
    const session = stack.forSession(auth);
    await session.setUnlisted(id, body.unlisted, {
      ifVersion: parseIfMatch(c.req.header('If-Match')),
    });
    return c.json(serializeRecord((await session.get(id))!));
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
    const session = stack.forSession(auth);
    await session.associate(id, body, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord((await session.get(id))!));
  });

  // POST, not DELETE — a DELETE request body has no defined semantics
  // (RFC 9110 §9.3.5) and is a portability landmine for proxies/gateways
  // that drop or reject it.
  app.post('/:id/associations/delete', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<Association>(c);
    const session = stack.forSession(auth);
    await session.dissociate(id, body, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.json(serializeRecord((await session.get(id))!));
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
  // Body carries the full post-migration content (computed client-side by
  // the type's owning app); ScopedStack.commitMigration() validates it
  // against toTypeId's schema before writing. Owner acting alone, only —
  // ScopedStack.commitMigration()'s own doc: replacing content and typeId
  // wholesale would have to re-derive every gate create()/update() apply at
  // both ends, and grant-based access would reopen the non-owner
  // _attachment@1 refusal that carve-out exists to close.
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
