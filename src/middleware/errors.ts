import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import { StackPermissionError, StackNotFoundError, type Stack } from '@haverstack/core';
import type { AppEnv } from '../types.js';
import { serializeError } from '@haverstack/wire-types';

/**
 * Central error handler. `serializeError()` covers every core `StackError`
 * (thrown directly by routes or surfaced from `Stack`/`ScopedStack`) with
 * the wire-format's typed `{ error: { code, message } }` body. Anything
 * else is an unanticipated bug: log it and return a bodyless 500 rather
 * than guessing at a taxonomy it doesn't belong to.
 *
 * `stack` is the unscoped root Stack, used only to probe existence for the
 * refusal log below — never to read content or bypass a permission check
 * for the response itself.
 */
export function errorMiddleware(logger: Logger, stack: Stack): ErrorHandler<AppEnv> {
  return async (err, c) => {
    const wire = serializeError(err);
    if (wire) {
      // A denial with a resolved auth is a verified DID that lacked the
      // grant, which docs/spec/identity.md asks be logged. Anonymous
      // denials are bodyless 401s from wireError() and never reach here.
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
      // On the wire a refused record is indistinguishable from a missing
      // one (docs/spec/wire-format.md § Server implementation checklist),
      // but the operator is not the adversary: an unscoped probe, on a path
      // already failing, recovers the distinction for the log alone. Debug
      // rather than warn — this is the sharing graph, which the spec asks
      // stay out of a general-purpose aggregator by default.
      if (err instanceof StackNotFoundError && auth) {
        const recordId = c.req.param('id');
        if (recordId) {
          const existing = await stack.get(recordId);
          logger.debug(
            {
              requestId: c.get('requestId'),
              principalId: auth.principalId,
              subjectId: auth.subjectId,
              recordId,
              existed: existing !== null,
              // Always 'read': ScopedStack collapses to StackNotFoundError
              // exactly when canRead() is false, whatever verb was asked.
              check: 'read',
            },
            'Refused a verified requester a 404',
          );
        }
      }
      // A 401 or 403 to an anonymous caller would confirm the record
      // exists to someone who presented no credential, so a private record
      // and a missing one answer alike. `Bearer` (RFC 6750 §3) — not the
      // `did-challenge` exchange discovery advertises for obtaining a
      // token — keeps the login prompt reachable without reopening that.
      if (wire.status === 404 && !auth) c.header('WWW-Authenticate', 'Bearer');
      return c.json(wire.body, wire.status as ContentfulStatusCode);
    }
    logger.error({ err, requestId: c.get('requestId') }, 'Unhandled request error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  };
}
