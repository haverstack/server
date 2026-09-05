import type { StackQuery } from '@haverstack/core';

// core's parsers (@haverstack/core/wire) report `limit` as requested and
// never clamp it — a ceiling is deployment policy, not wire contract. This
// server's ceiling, applied at the call site in records.ts.
export const MAX_QUERY_LIMIT = 1000;

export function clampLimit(query: StackQuery): StackQuery {
  if (query.limit === undefined) return query;
  return { ...query, limit: Math.min(query.limit, MAX_QUERY_LIMIT) };
}
