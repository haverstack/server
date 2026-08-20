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
  try {
    return await c.req.json<T>();
  } catch (err) {
    if (err instanceof SyntaxError) throw new StackQueryError('Invalid JSON in request body');
    throw err;
  }
}
