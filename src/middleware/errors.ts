import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import { StackPermissionError } from '@haverstack/core';
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
    if (wire) {
      // A permission denial with a resolved auth means the requester's DID
      // was verified (a real token, not just anonymous noise) but lacked
      // the grant — an actionable signal worth its own log line, per
      // docs/spec/identity.md's "SHOULD log the requester DID on
      // denied-but-verified requests". Anonymous denials never reach here:
      // they're bodyless 401s from wireError(), not thrown StackErrors.
      const auth = c.get('auth');
      if (err instanceof StackPermissionError && auth) {
        logger.warn(
          {
            requestId: c.get('requestId'),
            principalId: auth.principalId,
            subjectId: auth.subjectId,
          },
          'Denied a verified requester',
        );
      }
      return c.json(wire.body, wire.status as ContentfulStatusCode);
    }
    logger.error({ err, requestId: c.get('requestId') }, 'Unhandled request error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  };
}
