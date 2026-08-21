import type { Context } from 'hono';
import { StackQueryError } from '@haverstack/core';
import type { AppEnv } from '../types.js';

/**
 * `c.req.json()` throws a bare `SyntaxError` on malformed input, which isn't
 * a `StackError` — left uncaught it falls through errorMiddleware's
 * catch-all as an unlabeled 500 instead of the 400 `bad_request` every other
 * structurally-invalid request gets (docs/spec/wire-format.md § 400 vs 422).
 */
export async function readJson<T = unknown>(c: Context<AppEnv>): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await c.req.json<T>();
  } catch (err) {
    if (err instanceof SyntaxError) throw new StackQueryError('Invalid JSON in request body');
    throw err;
  }
  // A body of `null`, a bare string or a number parses fine but is not
  // something any route here can read: every call site indexes fields off
  // the result, so a non-object reaches the handler and throws a bare
  // TypeError — another unlabeled 500, and on /auth/challenge and
  // /auth/token an unauthenticated one. Structurally invalid in the same
  // way malformed JSON is, so it earns the same 400.
  if (parsed === null || typeof parsed !== 'object') {
    throw new StackQueryError('Request body must be a JSON object');
  }
  return parsed as T;
}
