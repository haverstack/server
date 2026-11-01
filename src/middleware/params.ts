import type { MiddlewareHandler } from 'hono';
import { StackBadRequestError } from '@haverstack/core';
import type { AppEnv } from '../types.js';

/**
 * Refuse any query param the route doesn't define, for the same reason
 * `rejectUnknownKeys()` refuses body keys. A route whose params one of
 * core's wire parsers reads leaves the check to that parser; this is for
 * the rest. See docs/spec/wire-format.md § Unrecognized input.
 */
export function knownParams(...names: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const unknown = [...new Set(new URL(c.req.url).searchParams.keys())].filter(
      (name) => !names.includes(name),
    );
    if (unknown.length > 0) {
      throw new StackBadRequestError(
        `Unknown query param${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
          `This endpoint takes: ${names.join(', ') || 'none'}.`,
      );
    }
    await next();
  };
}
