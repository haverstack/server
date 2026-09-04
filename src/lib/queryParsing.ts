import { parseDate } from '@haverstack/wire-types';
import { StackQueryError } from '@haverstack/core';
import type { StackQuery, RecordFilter, QuerySort } from '@haverstack/core';

const MAX_QUERY_LIMIT = 1000;

function getAll(url: URL, key: string): string[] {
  return url.searchParams.getAll(key);
}

function getOne(url: URL, key: string): string | null {
  return url.searchParams.get(key);
}

const POSITIVE_INTEGER = /^\d+$/;
const SORT_FIELDS: ReadonlySet<QuerySort['field']> = new Set(['createdAt', 'updatedAt', 'version']);
const SORT_DIRECTIONS: ReadonlySet<NonNullable<QuerySort['direction']>> = new Set(['asc', 'desc']);

/**
 * Strict positive-integer parse for URL path/query params — rejects "1abc",
 * "2.7", "-5", etc. Exported for the `:version` path params in records.ts,
 * which share this same "malformed, don't silently coerce" requirement.
 */
export function parsePositiveInt(raw: string, label: string): number {
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
export function parseQueryBody(raw: unknown): StackQuery {
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
        target: {
          scope: 'record',
          recordId: requireString(r.recordId, 'filter.relatedTo.recordId'),
        },
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
export function parseQueryParams(url: URL): StackQuery {
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
    filter.relatedTo = {
      target: { scope: 'record', recordId: relatedTo },
      ...(label && { label }),
    };
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
