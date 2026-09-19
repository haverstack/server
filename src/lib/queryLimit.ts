import type { StackQuery } from '@haverstack/core';

// core's parsers (@haverstack/core/wire) report `limit` as requested and
// never clamp it — a ceiling is deployment policy, not wire contract. This
// server's ceilings, applied at the call sites in records.ts.
export const MAX_QUERY_LIMIT = 1000;

export function clampLimit(query: StackQuery): StackQuery {
  if (query.limit === undefined) return query;
  return { ...query, limit: Math.min(query.limit, MAX_QUERY_LIMIT) };
}

// The journal is the one read with no ceiling when `limit` is omitted, so
// a page size can't be supplied on the caller's behalf: omitting `limit`
// reads the whole log by contract, and truncating it silently would betray
// exactly the caller reconstructing an association's full history. This
// server bounds a page and says so in `cursor` instead. See
// docs/spec/wire-format.md § Journal.
export const MAX_JOURNAL_LIMIT = 500;

export function clampJournalLimit(limit: number | undefined): number {
  return limit === undefined ? MAX_JOURNAL_LIMIT : Math.min(limit, MAX_JOURNAL_LIMIT);
}
