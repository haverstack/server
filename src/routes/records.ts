import { Hono } from 'hono';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import { requireAuth, requireOwner } from '../middleware/auth.js';
import { serializeRecord, serializeVersion } from '../lib/serialize.js';
import { SYSTEM_TYPES } from '@haverstack/core';
import type { StackQuery, RecordFilter, Association, Permission, TypeId } from '@haverstack/core';

// ---------------------------------------------------------------------------
// Query parsing helpers
// ---------------------------------------------------------------------------

function getAll(url: URL, key: string): string[] {
  return url.searchParams.getAll(key);
}

function getOne(url: URL, key: string): string | null {
  return url.searchParams.get(key);
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
        ...(r.before && { before: new Date(r.before) }),
        ...(r.after && { after: new Date(r.after) }),
      };
    }
    if (f.updatedAt) {
      const r = f.updatedAt as Record<string, string>;
      filter.updatedAt = {
        ...(r.before && { before: new Date(r.before) }),
        ...(r.after && { after: new Date(r.after) }),
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

  const tags = getAll(url, 'tag');
  if (tags.length) filter.tags = tags;

  const hasAttachment = getOne(url, 'hasAttachment');
  if (hasAttachment) filter.hasAttachment = hasAttachment;

  const attachmentFileId = getOne(url, 'attachmentFileId');
  if (attachmentFileId) filter.attachmentFileId = attachmentFileId;

  const relatedTo = getOne(url, 'relatedTo');
  if (relatedTo) {
    const label = getOne(url, 'relatedLabel');
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

const MAX_QUERY_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function recordRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;
  const { ownerEntityId } = stack;

  // POST /records/query — full query with content-field filters
  // Registered before /:id patterns to avoid param capture on the literal "query" segment.
  app.post('/query', requireAuth(), async (c) => {
    const auth = c.get('auth');
    const query = parseQueryBody(await c.req.json());
    const result = await stack.asEntity(auth?.entityId ?? null).query(query);
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      total: result.total,
    });
  });

  // GET /records — query by native fields via URL params
  app.get('/', async (c) => {
    const auth = c.get('auth');
    const query = parseQueryParams(new URL(c.req.url));
    const result = await stack.asEntity(auth?.entityId ?? null).query(query);
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      total: result.total,
    });
  });

  // POST /records — create (server generates the ID)
  app.post('/', requireAuth(), async (c) => {
    const auth = c.get('auth')!;
    const body = await c.req.json<Record<string, unknown>>();
    if (!body.typeId || typeof body.typeId !== 'string')
      return c.json({ error: 'typeId is required' }, 400);
    if (!body.content || typeof body.content !== 'object')
      return c.json({ error: 'content is required' }, 400);

    const created = await stack
      .asEntity(auth.entityId)
      .create(body.typeId as TypeId, body.content as Record<string, unknown>, {
        parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
        appId: typeof body.appId === 'string' ? body.appId : undefined,
        permissions: Array.isArray(body.permissions)
          ? (body.permissions as Permission[])
          : undefined,
        associations: Array.isArray(body.associations)
          ? (body.associations as Association[])
          : undefined,
      });
    return c.json(serializeRecord(created), 201);
  });

  // GET /records/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const record = await stack.asEntity(auth?.entityId ?? null).get(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);
    return c.json(serializeRecord(record));
  });

  // PATCH /records/:id — merges content patch (RFC 7396); null field values remove the field
  app.patch('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await c.req.json<Record<string, unknown>>();
    const patch = (body.content ?? {}) as Record<string, unknown>;

    const existing = await stack.get(id);
    if (existing) {
      if (existing.typeId.startsWith(`${SYSTEM_TYPES.ATTACHMENT}@`)) {
        const immutableFields = ['fileId', 'size', 'mimeType'];
        const attempted = immutableFields.filter((f) =>
          Object.prototype.hasOwnProperty.call(patch, f),
        );
        if (attempted.length > 0) {
          return c.json(
            { error: `Cannot modify immutable attachment fields: ${attempted.join(', ')}` },
            422,
          );
        }
      }
      if (
        existing.typeId.startsWith(`${SYSTEM_TYPES.GRANT}@`) &&
        auth.entityId !== stack.ownerEntityId
      ) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    const updated = await stack.asEntity(auth.entityId).update(id, patch);
    return c.json(serializeRecord(updated));
  });

  // DELETE /records/:id  (?hard=true for permanent)
  app.delete('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const hard = new URL(c.req.url).searchParams.get('hard') === 'true';
    if (hard && auth.entityId !== stack.ownerEntityId) return c.json({ error: 'Forbidden' }, 403);

    const existing = await stack.get(id);
    if (
      existing &&
      existing.typeId.startsWith(`${SYSTEM_TYPES.GRANT}@`) &&
      auth.entityId !== stack.ownerEntityId
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await stack.asEntity(auth.entityId).delete(id, { hard });
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------
  // Permissions
  // ------------------------------------------------------------------

  app.get('/:id/permissions', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const record = await stack.asEntity(auth?.entityId ?? null).get(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);
    return c.json({ permissions: record.permissions ?? [] });
  });

  app.put('/:id/permissions', requireOwner(ownerEntityId), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await c.req.json<{ permissions: Permission[] }>();
    if (!Array.isArray(body.permissions))
      return c.json({ error: 'permissions must be an array' }, 400);
    await stack.asEntity(auth.entityId).setPermissions(id, body.permissions);
    return c.json({ permissions: body.permissions });
  });

  // ------------------------------------------------------------------
  // Associations
  // ------------------------------------------------------------------

  app.get('/:id/associations', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const record = await stack.asEntity(auth?.entityId ?? null).get(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);
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
    const body = await c.req.json<Association>();
    if (!body.kind || !body.label) return c.json({ error: 'kind and label are required' }, 400);
    await stack.asEntity(auth.entityId).associate(id, body);
    return c.body(null, 204);
  });

  app.delete('/:id/associations', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const body = await c.req.json<Association>();
    await stack.asEntity(auth.entityId).dissociate(id, body);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------
  // Versions
  // ------------------------------------------------------------------

  app.get('/:id/versions', async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth');
    const versions = await stack.asEntity(auth?.entityId ?? null).getVersions(id);
    return c.json(versions.map(serializeVersion));
  });

  app.get('/:id/versions/:version', async (c) => {
    const id = c.req.param('id');
    const vNum = parseInt(c.req.param('version'), 10);
    if (isNaN(vNum)) return c.json({ error: 'Invalid version number' }, 400);
    const auth = c.get('auth');
    const version = await stack.asEntity(auth?.entityId ?? null).getVersion(id, vNum);
    if (!version) return c.json({ error: 'Version not found' }, 404);
    return c.json(serializeVersion(version));
  });

  // POST /records/:id/restore/:version — creates new version, does not rewrite history
  app.post('/:id/restore/:version', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const vNum = parseInt(c.req.param('version'), 10);
    if (isNaN(vNum)) return c.json({ error: 'Invalid version number' }, 400);
    const auth = c.get('auth')!;
    const restored = await stack.asEntity(auth.entityId).restoreVersion(id, vNum);
    return c.json(serializeRecord(restored));
  });

  return app;
}
