/**
 * @haverstack/core/wire's parsers report `limit` as requested and never
 * clamp it — a ceiling is deployment policy, not wire contract (core#240 /
 * server#114). This server's ceiling is applied here, at the call site in
 * records.ts, and pins the one behavioural detail worth being careful
 * about in that migration: `limit=5000` in must still yield `1000` out.
 */
import { describe, it, expect } from 'vitest';
import { clampLimit, MAX_QUERY_LIMIT } from '../../src/lib/queryLimit.js';

describe('clampLimit', () => {
  it('clamps a limit above the ceiling down to it', () => {
    expect(clampLimit({ limit: 5000 })).toEqual({ limit: MAX_QUERY_LIMIT });
  });

  it('leaves a limit at or under the ceiling untouched', () => {
    expect(clampLimit({ limit: MAX_QUERY_LIMIT })).toEqual({ limit: MAX_QUERY_LIMIT });
    expect(clampLimit({ limit: 10 })).toEqual({ limit: 10 });
  });

  it('leaves an absent limit absent, not defaulted', () => {
    expect(clampLimit({})).toEqual({});
  });

  it('preserves the rest of the query', () => {
    const query = { filter: { typeId: 'note@1' }, limit: 5000, cursor: 'abc' };
    expect(clampLimit(query)).toEqual({
      filter: { typeId: 'note@1' },
      limit: MAX_QUERY_LIMIT,
      cursor: 'abc',
    });
  });
});
