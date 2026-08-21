import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { ScopedStack, TokenSession } from '@haverstack/core';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { readJson } from '../lib/json.js';
import { parseDate, serializeRecord, serializeVersion } from '@haverstack/wire-types';
import { StackValidationError, StackQueryError, StackNotFoundError } from '@haverstack/core';
import type {
  StackQuery,
  RecordFilter,
  QuerySort,
  Association,
  Permission,
  TypeId,
} from '@haverstack/core';

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

const POSITIVE_INTEGER = /^\d+$/;
const SORT_FIELDS: ReadonlySet<QuerySort['field']> = new Set([
  'createdAt',
  'updatedAt',
  'version',
]);
const SORT_DIRECTIONS: ReadonlySet<NonNullable<QuerySort['direction']>> = new Set([
  'asc',
  'desc',
]);

/** Strict positive-integer parse for URL path/query params — rejects "1abc", "2.7", "-5", etc. */
function parsePositiveInt(raw: string, label: string): number {
  if (!POSITIVE_INTEGER.test(raw)) throw new StackQueryError(`Invalid ${label}: "${raw}"`);
  return parseInt(raw, 10);
}

/** Validate and clamp a `?limit=` query param: must be a positive integer, else 400. */
function parseLimit(raw: string): number {
  return Math.min(parsePositiveInt(raw, 'limit'), MAX_QUERY_LIMIT);
}

/** Validate a limit that already arrived as a JSON number (POST /records/query body). */
function parseLimitValue(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)
    throw new StackQueryError(`Invalid limit: ${JSON.stringify(raw)}`);
  return Math.min(raw, MAX_QUERY_LIMIT);
}

/** Parse a wire date value, throwing rather than silently dropping an invalid bound. */
function requireDate(raw: unknown, label: string): Date {
  const d = parseDate(raw);
  if (!d) throw new StackQueryError(`Invalid ${label}: ${JSON.stringify(raw)}`);
  return d;
}

function requireSortField(raw: unknown): QuerySort['field'] {
  if (typeof raw !== 'string' || !SORT_FIELDS.has(raw as QuerySort['field']))
    throw new StackQueryError(`Invalid sort field: ${JSON.stringify(raw)}`);
  return raw as QuerySort['field'];
}

function requireSortDirection(raw: unknown): NonNullable<QuerySort['direction']> {
  if (typeof raw !== 'string' || !SORT_DIRECTIONS.has(raw as NonNullable<QuerySort['direction']>))
    throw new StackQueryError(`Invalid sort direction: ${JSON.stringify(raw)}`);
  return raw as NonNullable<QuerySort['direction']>;
}

function requireString(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new StackQueryError(`Invalid ${label}: expected a string`);
  return raw;
}

function requireStringOrArray(raw: unknown, label: string): string | string[] {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return raw as string[];
  throw new StackQueryError(`Invalid ${label}: expected a string or array of strings`);
}

function requireStringArray(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string'))
    throw new StackQueryError(`Invalid ${label}: expected an array of strings`);
  return raw as string[];
}

function requirePlainObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new StackQueryError(`Invalid ${label}: expected an object`);
  return raw as Record<string, unknown>;
}

/** Convert wire ISO strings back to Date objects inside a StackQuery body. */
function parseQueryBody(raw: unknown): StackQuery {
  if (!raw || typeof raw !== 'object') return {};
  const body = raw as Record<string, unknown>;
  const query: StackQuery = {};

  if (body.filter) {
    const f = body.filter as Record<string, unknown>;
    const filter: RecordFilter = {};

    if (f.typeId !== undefined) filter.typeId = requireStringOrArray(f.typeId, 'filter.typeId');
    if (f.parentId !== undefined)
      filter.parentId = f.parentId === null ? null : requireString(f.parentId, 'filter.parentId');
    if (f.appId !== undefined) filter.appId = requireStringOrArray(f.appId, 'filter.appId');
    if (f.entityId !== undefined)
      filter.entityId = requireStringOrArray(f.entityId, 'filter.entityId');
    if (f.principalId !== undefined)
      filter.principalId = requireStringOrArray(f.principalId, 'filter.principalId');
    if (f.tags !== undefined) filter.tags = requireStringArray(f.tags, 'filter.tags');
    if (f.hasAttachment !== undefined)
      filter.hasAttachment = requireString(f.hasAttachment, 'filter.hasAttachment');
    if (f.attachmentFileId !== undefined)
      filter.attachmentFileId = requireString(f.attachmentFileId, 'filter.attachmentFileId');
    if (f.relatedTo !== undefined) {
      const r = requirePlainObject(f.relatedTo, 'filter.relatedTo');
      filter.relatedTo = {
        recordId: requireString(r.recordId, 'filter.relatedTo.recordId'),
        ...(r.label !== undefined && { label: requireString(r.label, 'filter.relatedTo.label') }),
      };
    }
    if (f.content !== undefined) filter.content = requirePlainObject(f.content, 'filter.content');
    if (f.search !== undefined) filter.search = requireString(f.search, 'filter.search');
    if (f.includeDeleted) filter.includeDeleted = true;

    if (f.createdAt) {
      const r = f.createdAt as Record<string, unknown>;
      filter.createdAt = {
        ...(r.before !== undefined && {
          before: requireDate(r.before, 'filter.createdAt.before'),
        }),
        ...(r.after !== undefined && { after: requireDate(r.after, 'filter.createdAt.after') }),
      };
    }
    if (f.updatedAt) {
      const r = f.updatedAt as Record<string, unknown>;
      filter.updatedAt = {
        ...(r.before !== undefined && {
          before: requireDate(r.before, 'filter.updatedAt.before'),
        }),
        ...(r.after !== undefined && { after: requireDate(r.after, 'filter.updatedAt.after') }),
      };
    }

    query.filter = filter;
  }

  if (body.sort) {
    const s = body.sort as Record<string, unknown>;
    query.sort = {
      field: requireSortField(s.field),
      ...(s.direction !== undefined && { direction: requireSortDirection(s.direction) }),
    };
  }

  if (body.limit !== undefined) query.limit = parseLimitValue(body.limit);
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
      ...(createdBefore && { before: requireDate(createdBefore, 'createdBefore') }),
      ...(createdAfter && { after: requireDate(createdAfter, 'createdAfter') }),
    };
  }

  const updatedBefore = getOne(url, 'updatedBefore');
  const updatedAfter = getOne(url, 'updatedAfter');
  if (updatedBefore || updatedAfter) {
    filter.updatedAt = {
      ...(updatedBefore && { before: requireDate(updatedBefore, 'updatedBefore') }),
      ...(updatedAfter && { after: requireDate(updatedAfter, 'updatedAfter') }),
    };
  }

  if (getOne(url, 'includeDeleted') === 'true') filter.includeDeleted = true;

  const query: StackQuery = {};
  if (Object.keys(filter).length) query.filter = filter;

  const sort = getOne(url, 'sort');
  const direction = getOne(url, 'direction');
  if (sort)
    query.sort = {
      field: requireSortField(sort),
      ...(direction && { direction: requireSortDirection(direction) }),
    };

  const limit = getOne(url, 'limit');
  if (limit) query.limit = parseLimit(limit);

  const cursor = getOne(url, 'cursor');
  if (cursor) query.cursor = cursor;

  return query;
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

  // POST /records/query — full query with content-field filters
  // Registered before /:id patterns to avoid param capture on the literal "query" segment.
  app.post('/query', requireAuth(), async (c) => {
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
