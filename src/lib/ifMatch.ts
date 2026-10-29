import type { Context } from 'hono';
import type { IfVersionOptions } from '@haverstack/core';
import { StackBadRequestError } from '@haverstack/core';
import { parseIfMatch } from '@haverstack/core/wire';
import type { AppEnv } from '../types.js';

/**
 * Every write reads `If-Match` and checks it when present. A record write
 * fences on its version, which core's parseIfMatch() reads; a write on
 * something the server defines fences on an opaque tag it minted, which
 * ifMatchTag() reads. Either way a malformed header is a 400, never a
 * fallthrough to unconditional. See docs/spec/wire-format.md
 * § Optimistic concurrency.
 */
export function ifMatchVersion(c: Context<AppEnv>): IfVersionOptions {
  return { ifVersion: parseIfMatch(c.req.header('If-Match')) };
}

/** A strong entity tag, quoted or bare; a weak comparator or `*` is refused. */
export function ifMatchTag(c: Context<AppEnv>): string | undefined {
  const header = c.req.header('If-Match');
  if (header === undefined) return undefined;
  const match = /^"?([A-Za-z0-9_-]+)"?$/.exec(header.trim());
  if (!match) throw new StackBadRequestError(`Invalid If-Match: "${header}"`);
  return match[1];
}
