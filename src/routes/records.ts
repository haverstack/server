import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { ScopedStack, TokenSession } from '@haverstack/core';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { parseDate, serializeRecord, serializeVersion } from '@haverstack/wire-types';
import { StackValidationError, StackQueryError, StackNotFoundError } from '@haverstack/core';
import type { StackQuery, RecordFilter, Association, Permission, TypeId } from '@haverstack/core';

const MAX_QUERY_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Query parsing helpers
// ---------------------------------------------------------------------------

function getAll(url: URL, key: string): string[] {
  return url.searchParams.getAll(key);
}

function getOne(url: URL, key: string): string | null {
  return url.searchParams.get(key);
}

/** Parse an `If-Match: "5"` header into the version number for `ifVersion`. */
function parseIfMatch(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const n = parseInt(header.replace(/^"|"$/g, ''), 10);
  return isNaN(n) ? undefined : n;
}

/** Convert wire ISO strings back to Date objects inside a StackQuery body. */
function parseQueryBody(raw: unknown): StackQuery {
  if (!raw || typeof raw !== 'object') return {};
  const body = raw as Record<string, unknown>;
  const query: StackQuery = {};

  if (body.filter) {
    const f = body.filter as Record<string, unknown>;
    const filter: RecordFilter = {};

    if (f.typeId !== undefined) filter.typeId = f.typeId as string | string[];
    if (f.parentId !== undefined)
      filter.parentId = f.parentId === null ? null : (f.parentId as string);
    if (f.appId !== undefined) filter.appId = f.appId as string | string[];
    if (f.entityId !== undefined) filter.entityId = f.entityId as string | string[];
    if (f.principalId !== undefined) filter.principalId = f.principalId as string | string[];
    if (f.tags !== undefined) filter.tags = f.tags as string[];
    if (f.hasAttachment !== undefined) filter.hasAttachment = f.hasAttachment as string;
    if (f.attachmentFileId !== undefined) filter.attachmentFileId = f.attachmentFileId as string;
    if (f.relatedTo !== undefined)
      filter.relatedTo = f.relatedTo as { recordId: string; label?: string };
    if (f.content !== undefined) filter.content = f.content as Record<string, unknown>;
    if (f.search !== undefined) filter.search = f.search as string;
    if (f.includeDeleted) filter.includeDeleted = true;

    if (f.createdAt) {
      const r = f.createdAt as Record<string, string>;
      filter.createdAt = {
        ...(r.before && { before: parseDate(r.before) }),
        ...(r.after && { after: parseDate(r.after) }),
      };
    }
    if (f.updatedAt) {
      const r = f.updatedAt as Record<string, string>;
      filter.updatedAt = {
        ...(r.before && { before: parseDate(r.before) }),
        ...(r.after && { after: parseDate(r.after) }),
      };
    }

    query.filter = filter;
  }

  if (body.sort) {
    const s = body.sort as Record<string, string>;
    query.sort = {
      field: s.field as 'createdAt' | 'updatedAt' | 'version',
      ...(s.direction && { direction: s.direction as 'asc' | 'desc' }),
    };
  }

  if (typeof body.limit === 'number') query.limit = Math.min(body.limit, MAX_QUERY_LIMIT);
  if (typeof body.cursor === 'string') query.cursor = body.cursor;

  return query;
}

/** Build a StackQuery from GET /records URL search params. */
function parseQueryParams(url: URL): StackQuery {
  const filter: RecordFilter = {};

  const typeIds = getAll(url, 'typeId');
  if (typeIds.length) filter.typeId = typeIds.length === 1 ? typeIds[0] : typeIds;

  const parentId = getOne(url, 'parentId');
  if (parentId !== null) filter.parentId = parentId === 'null' ? null : parentId;

  const appIds = getAll(url, 'appId');
  if (appIds.length) filter.appId = appIds.length === 1 ? appIds[0] : appIds;

  const entityIds = getAll(url, 'entityId');
  if (entityIds.length) filter.entityId = entityIds.length === 1 ? entityIds[0] : entityIds;

  const principalIds = getAll(url, 'principalId');
  if (principalIds.length)
    filter.principalId = principalIds.length === 1 ? principalIds[0] : principalIds;

  const tags = getAll(url, 'tag');
  if (tags.length) filter.tags = tags;

  const hasAttachment = getOne(url, 'hasAttachment');
  if (hasAttachment) filter.hasAttachment = hasAttachment;

  const attachmentFileId = getOne(url, 'attachmentFileId');
  if (attachmentFileId) filter.attachmentFileId = attachmentFileId;

  const relatedTo = getOne(url, 'relatedTo');
  if (relatedTo) {
    const label = getOne(url, 'relatedToLabel');
    filter.relatedTo = { recordId: relatedTo, ...(label && { label }) };
  }

  const search = getOne(url, 'search');
  if (search) filter.search = search;

  const createdBefore = getOne(url, 'createdBefore');
  const createdAfter = getOne(url, 'createdAfter');
  if (createdBefore || createdAfter) {
    filter.createdAt = {
      ...(createdBefore && { before: new Date(createdBefore) }),
      ...(createdAfter && { after: new Date(createdAfter) }),
    };
  }

  const updatedBefore = getOne(url, 'updatedBefore');
  const updatedAfter = getOne(url, 'updatedAfter');
  if (updatedBefore || updatedAfter) {
    filter.updatedAt = {
      ...(updatedBefore && { before: new Date(updatedBefore) }),
      ...(updatedAfter && { after: new Date(updatedAfter) }),
    };
  }

  if (getOne(url, 'includeDeleted') === 'true') filter.includeDeleted = true;

  const query: StackQuery = {};
  if (Object.keys(filter).length) query.filter = filter;

  const sort = getOne(url, 'sort') as 'createdAt' | 'updatedAt' | 'version' | null;
  const direction = getOne(url, 'direction') as 'asc' | 'desc' | null;
  if (sort) query.sort = { field: sort, ...(direction && { direction }) };

  const limit = getOne(url, 'limit');
  if (limit) query.limit = Math.min(parseInt(limit, 10), MAX_QUERY_LIMIT);

  const cursor = getOne(url, 'cursor');
  if (cursor) query.cursor = cursor;

  return query;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function recordRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  /** Scope to a session if authenticated, else the anonymous view. */
  function scopeFor(auth: TokenSession | null): ScopedStack {
    return auth ? stack.forSession(auth) : stack.asEntity(null);
  }

  // POST /records/query — full query with content-field filters
  // Registered before /:id patterns to avoid param capture on the literal "query" segment.
  app.post('/query', requireAuth(), async (c) => {
    const auth = c.get('auth');
    const query = parseQueryBody(await readJson(c));
    const result = await scopeFor(auth).query(query);
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
    const result = await scopeFor(auth).query(query);
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
  // — omit it to let ScopedStack.create() generate one. createdAt/updatedAt/
  // version are never accepted from the client: those are always freshly
  // generated for a new record, same as entityId/principalId (stamped from
  // the authenticated session, never trusted from the body).
  app.post('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const body = await readJson<Record<string, unknown>>(c);
    if (!body.typeId || typeof body.typeId !== 'string')
      throw new StackQueryError('typeId is required');
    if (!body.content || typeof body.content !== 'object')
      throw new StackQueryError('content is required');
    if (!(await stack.getType(body.typeId as TypeId)))
      throw new StackValidationError([
        { path: 'typeId', message: `Unknown type: "${body.typeId}"` },
      ]);

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

  // DELETE /records/:id  (?hard=true for permanent)
  app.delete('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const hard = new URL(c.req.url).searchParams.get('hard') === 'true';

    await stack
      .forSession(auth)
      .delete(id, { hard, ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.body(null, 204);
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
    await stack
      .forSession(auth)
      .setPermissions(id, body.permissions, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.body(null, 204);
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
    await stack
      .forSession(auth)
      .associate(id, body, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.body(null, 204);
  });

  // POST, not DELETE — a DELETE request body has no defined semantics
  // (RFC 9110 §9.3.5) and is a portability landmine for proxies/gateways
  // that drop or reject it.
  app.post('/:id/associations/delete', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await readJson<Association>(c);
    await stack
      .forSession(auth)
      .dissociate(id, body, { ifVersion: parseIfMatch(c.req.header('If-Match')) });
    return c.body(null, 204);
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
    const vNum = parseInt(c.req.param('version'), 10);
    if (isNaN(vNum)) throw new StackQueryError('Invalid version number');
    const auth = c.get('auth');
    const version = await scopeFor(auth).getVersion(id, vNum);
    if (!version) throw new StackNotFoundError('Version not found');
    return c.json(serializeVersion(version));
  });

  // POST /records/:id/restore/:version — creates new version, does not rewrite history
  app.post('/:id/restore/:version', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const vNum = parseInt(c.req.param('version'), 10);
    if (isNaN(vNum)) throw new StackQueryError('Invalid version number');
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
