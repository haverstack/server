import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './types.js';

/**
 * `{ error: { code, message } }` responses for failures outside the core
 * `StackError` taxonomy — thrown core errors instead flow through
 * `errorMiddleware` via `serializeError()`. `code` is a server-local
 * extension for these (not `WireErrorCode`): `unauthorized` for a missing
 * or invalid bearer token has no core class, per
 * docs/spec/wire-format.md § Error responses ("no verified DID behind the
 * request at all" predates any Stack operation).
 */
export function wireError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}
