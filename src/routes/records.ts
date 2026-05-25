import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';
import { checkAccess } from '../lib/access.js';
import { serializeRecord, serializeVersion } from '../lib/serialize.js';
import type {
  StackRecord,
  StackQuery,
  RecordFilter,
  Association,
  Permission,
} from '@haverstack/core';

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

  if (typeof body.limit === 'number') query.limit = body.limit;
  if (typeof body.cursor === 'string') query.cursor = body.cursor;

  return query;
}

/** Build a StackQuery from GET /records URL params. */
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

  const relatedTo = getOne(url, 'relatedTo');
  if (relatedTo) {
    const relatedLabel = getOne(url, 'relatedLabel');
    filter.relatedTo = { recordId: relatedTo, ...(relatedLabel && { label: relatedLabel }) };
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
  if (limit) query.limit = parseInt(limit, 10);

  const cursor = getOne(url, 'cursor');
  if (cursor) query.cursor = cursor;

  return query;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function recordRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;
  const ownerEntityId = stack.ownerEntityId;

  // ------------------------------------------------------------------
  // POST /records/query — full query including content field filters
  // Must be registered before /:id to avoid param capture
  // ------------------------------------------------------------------
  app.post('/query', requireAuth(), async (c) => {
    const body = await c.req.json();
    const query = parseQueryBody(body);
    const result = await adapter.queryRecords(query);
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      total: result.total,
    });
  });

  // ------------------------------------------------------------------
  // GET /records — query by native fields via query params
  // ------------------------------------------------------------------
  app.get('/', requireAuth(), async (c) => {
    const url = new URL(c.req.url);
    const query = parseQueryParams(url);
    const result = await adapter.queryRecords(query);
    return c.json({
      records: result.records.map(serializeRecord),
      cursor: result.cursor,
      total: result.total,
    });
  });

  // ------------------------------------------------------------------
  // POST /records — create a record
  // ------------------------------------------------------------------
  app.post('/', requireAuth(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>();

    if (!body.id || typeof body.id !== 'string') return c.json({ error: 'id is required' }, 400);
    if (!body.typeId || typeof body.typeId !== 'string')
      return c.json({ error: 'typeId is required' }, 400);
    if (!body.content || typeof body.content !== 'object')
      return c.json({ error: 'content is required' }, 400);

    const now = new Date();
    const record: StackRecord = {
      id: body.id,
      typeId: body.typeId,
      createdAt: body.createdAt ? new Date(body.createdAt as string) : now,
      updatedAt: body.updatedAt ? new Date(body.updatedAt as string) : now,
      content: body.content as Record<string, unknown>,
      version: typeof body.version === 'number' ? body.version : 1,
      ...(body.parentId && { parentId: body.parentId as string }),
      ...(body.entityId && { entityId: body.entityId as string }),
      ...(body.appId && { appId: body.appId as string }),
      ...(body.permissions && { permissions: body.permissions as Permission[] }),
      ...(body.associations && { associations: body.associations as Association[] }),
    };

    const created = await adapter.createRecord(record);
    return c.json(serializeRecord(created), 201);
  });

  // ------------------------------------------------------------------
  // GET /records/:id — get one record
  // ------------------------------------------------------------------
  app.get('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const record = await adapter.getRecord(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    const canRead = await checkAccess(record, auth.entityId, ownerEntityId, 'read', adapter);
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

    return c.json(serializeRecord(record));
  });

  // ------------------------------------------------------------------
  // PATCH /records/:id — update record (partial merge)
  // ------------------------------------------------------------------
  app.patch('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const existing = await adapter.getRecord(id);
    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const canWrite = await checkAccess(existing, auth.entityId, ownerEntityId, 'write', adapter);
    if (!canWrite) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json<Record<string, unknown>>();

    // Snapshot current state before overwriting (server-side versioning)
    await adapter.saveVersion(id, {
      version: existing.version,
      content: existing.content,
      updatedAt: existing.updatedAt,
      ...(existing.entityId && { entityId: existing.entityId }),
    });

    const updated = await adapter.updateRecord(id, {
      ...(body.content !== undefined && { content: body.content as Record<string, unknown> }),
      ...(body.typeId !== undefined && { typeId: body.typeId as string }),
      updatedAt: body.updatedAt ? new Date(body.updatedAt as string) : new Date(),
      version: typeof body.version === 'number' ? body.version : existing.version + 1,
    });

    return c.json(serializeRecord(updated));
  });

  // ------------------------------------------------------------------
  // DELETE /records/:id — soft or hard delete
  // ------------------------------------------------------------------
  app.delete('/:id', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const existing = await adapter.getRecord(id);
    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const canWrite = await checkAccess(existing, auth.entityId, ownerEntityId, 'write', adapter);
    if (!canWrite) return c.json({ error: 'Forbidden' }, 403);

    const hard = new URL(c.req.url).searchParams.get('hard') === 'true';
    await adapter.deleteRecord(id, { hard });
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------
  // Permissions
  // ------------------------------------------------------------------

  app.get('/:id/permissions', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const record = await adapter.getRecord(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    const canRead = await checkAccess(record, auth.entityId, ownerEntityId, 'read', adapter);
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

    return c.json({ permissions: record.permissions ?? [] });
  });

  app.put('/:id/permissions', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const existing = await adapter.getRecord(id);
    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const canWrite = await checkAccess(existing, auth.entityId, ownerEntityId, 'write', adapter);
    if (!canWrite) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json<{ permissions: Permission[] }>();
    if (!Array.isArray(body.permissions)) {
      return c.json({ error: 'permissions must be an array' }, 400);
    }

    await adapter.updateRecord(id, { permissions: body.permissions });
    return c.json({ permissions: body.permissions });
  });

  // ------------------------------------------------------------------
  // Associations
  // ------------------------------------------------------------------

  app.get('/:id/associations', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const record = await adapter.getRecord(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    const canRead = await checkAccess(record, auth.entityId, ownerEntityId, 'read', adapter);
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

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
    const existing = await adapter.getRecord(id);
    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const canWrite = await checkAccess(existing, auth.entityId, ownerEntityId, 'write', adapter);
    if (!canWrite) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json<Association>();
    if (!body.kind || !body.label) {
      return c.json({ error: 'kind and label are required' }, 400);
    }

    await adapter.associate(id, body);
    return c.body(null, 204);
  });

  app.delete('/:id/associations', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const existing = await adapter.getRecord(id);
    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const canWrite = await checkAccess(existing, auth.entityId, ownerEntityId, 'write', adapter);
    if (!canWrite) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json<Association>();
    await adapter.dissociate(id, body);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------
  // Versions
  // ------------------------------------------------------------------

  app.get('/:id/versions', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const auth = c.get('auth')!;
    const record = await adapter.getRecord(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    const canRead = await checkAccess(record, auth.entityId, ownerEntityId, 'read', adapter);
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

    const versions = await adapter.getVersions(id);
    return c.json(versions.map(serializeVersion));
  });

  app.get('/:id/versions/:version', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const vNum = parseInt(c.req.param('version'), 10);
    const auth = c.get('auth')!;
    const record = await adapter.getRecord(id);
    if (!record) return c.json({ error: 'Record not found' }, 404);

    const canRead = await checkAccess(record, auth.entityId, ownerEntityId, 'read', adapter);
    if (!canRead) return c.json({ error: 'Forbidden' }, 403);

    if (isNaN(vNum)) return c.json({ error: 'Invalid version number' }, 400);
    const version = await adapter.getVersion(id, vNum);
    if (!version) return c.json({ error: 'Version not found' }, 404);
    return c.json(serializeVersion(version));
  });

  // Restore a version — creates a new version, does not rewrite history
  app.post('/:id/restore/:version', requireAuth(), async (c) => {
    const id = c.req.param('id');
    const vNum = parseInt(c.req.param('version'), 10);
    const auth = c.get('auth')!;

    if (isNaN(vNum)) return c.json({ error: 'Invalid version number' }, 400);

    const existing = await adapter.getRecord(id);
    if (!existing) return c.json({ error: 'Record not found' }, 404);

    const canWrite = await checkAccess(existing, auth.entityId, ownerEntityId, 'write', adapter);
    if (!canWrite) return c.json({ error: 'Forbidden' }, 403);

    const target = await adapter.getVersion(id, vNum);
    if (!target) return c.json({ error: 'Version not found' }, 404);

    // Snapshot current state before restoring
    await adapter.saveVersion(id, {
      version: existing.version,
      content: existing.content,
      updatedAt: existing.updatedAt,
      ...(existing.entityId && { entityId: existing.entityId }),
    });

    const restored = await adapter.updateRecord(id, {
      content: target.content,
      updatedAt: new Date(),
      version: existing.version + 1,
    });

    return c.json(serializeRecord(restored));
  });

  return app;
}
