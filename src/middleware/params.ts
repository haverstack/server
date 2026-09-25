import type { MiddlewareHandler } from 'hono';
import { StackBadRequestError } from '@haverstack/core';
import type { AppEnv } from '../types.js';

/**
 * Refuse any query param the route doesn't define, for the same reason
 * `rejectUnknownKeys()` refuses body keys. Routes whose params core's wire
 * parsers read (`GET /records`, `GET /changes`, the journal) leave the
 * check to those parsers.
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

/** A boolean query param: absent is false, and anything but `true`/`false` is refused. */
export function booleanParam(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  if (value === null || value === 'false') return false;
  if (value === 'true') return true;
  throw new StackBadRequestError(`Invalid ${name}: expected true or false, got "${value}"`);
}
