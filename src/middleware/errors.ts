import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import type { AppEnv } from '../types.js';
import { serializeError } from '@haverstack/wire-types';

/**
 * Central error handler. `serializeError()` covers every core `StackError`
 * (thrown directly by routes or surfaced from `Stack`/`ScopedStack`) with
 * the wire-format's typed `{ error: { code, message } }` body. Anything
 * else is an unanticipated bug: log it and return a bodyless 500 rather
 * than guessing at a taxonomy it doesn't belong to.
 */
export function errorMiddleware(logger: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    const wire = serializeError(err);
    if (wire) return c.json(wire.body, wire.status as ContentfulStatusCode);
    logger.error({ err, requestId: c.get('requestId') }, 'Unhandled request error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  };
}
