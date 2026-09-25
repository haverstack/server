import type { Context } from 'hono';
import { StackBadRequestError } from '@haverstack/core';
import type { AppEnv } from '../types.js';

/**
 * `c.req.json()` throws a bare `SyntaxError` on malformed input, which isn't
 * a `StackError` — left uncaught it falls through errorMiddleware's
 * catch-all as an unlabeled 500 instead of the 400 `bad_request` every other
 * structurally-invalid request gets (docs/spec/wire-format.md § Error responses).
 */
export async function readJson<T = unknown>(
  c: Context<AppEnv>,
  keys?: readonly string[],
): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await c.req.json<T>();
  } catch (err) {
    if (err instanceof SyntaxError) throw new StackBadRequestError('Invalid JSON in request body');
    throw err;
  }
  // `null`, a bare string or a number parses fine, but every call site
  // indexes fields off the result, so a non-object reaches the handler and
  // throws a bare TypeError — another unlabeled 500, unauthenticated on the
  // /auth routes. Structurally invalid like malformed JSON, so a 400 too.
  if (parsed === null || typeof parsed !== 'object') {
    throw new StackBadRequestError('Request body must be a JSON object');
  }
  if (keys) rejectUnknownKeys(parsed as Record<string, unknown>, keys);
  return parsed as T;
}

/**
 * A key the endpoint doesn't define is refused rather than ignored: an
 * ignored field turns a mistaken request into a different one that
 * succeeds, and the caller never learns it asked for something else.
 */
export function rejectUnknownKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw new StackBadRequestError(
      `Unknown body key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `This endpoint takes: ${keys.join(', ') || 'no keys'}.`,
    );
  }
}
