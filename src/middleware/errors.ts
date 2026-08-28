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
      // A StackNotFoundError for a verified requester is deliberately
      // indistinguishable, on the wire, from a genuinely missing record
      // (docs/spec/wire-format.md § Server implementation checklist,
      // "Log the refusal you didn't send") — that's the anti-oracle rule
      // #79 adopted. But the operator is not the adversary: an unscoped
      // existence probe here (one extra read, only on a path that's
      // already failing) recovers the distinction for the log without
      // ever surfacing it to the client. `check` is always 'read' because
      // ScopedStack's denialFor()/get() both collapse into
      // StackNotFoundError exactly when canRead() is false, regardless of
      // which verb (update/delete/etc.) the request asked for — there's no
      // second gate to name here.
      //
      // Logged at debug, not warn: unlike the denial line above, this one
      // is "who asked after what, and was refused" — the sharing graph,
      // written down — and the spec asks that it not ship to a
      // general-purpose aggregator by default (default LOG_LEVEL is info).
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
              check: 'read',
            },
            'Refused a verified requester a 404',
          );
        }
      }
      // An anonymous requester gets the same 404 for a private record as for
      // a missing one (docs/spec/wire-format.md § Server implementation
      // checklist): a bare 403 or 401 here would confirm the record exists
      // to a caller who presented no credential at all. `WWW-Authenticate`
      // keeps the login prompt reachable without reopening that
      // distinction — RFC 7235's standard scheme for a bearer-token API is
      // `Bearer` (RFC 6750 §3), not the higher-level `did-challenge`
      // exchange discovery advertises for obtaining that token.
      if (wire.status === 404 && !auth) c.header('WWW-Authenticate', 'Bearer');
      return c.json(wire.body, wire.status as ContentfulStatusCode);
    }
    logger.error({ err, requestId: c.get('requestId') }, 'Unhandled request error');
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  };
}
