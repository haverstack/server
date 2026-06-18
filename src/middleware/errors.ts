import type { ErrorHandler } from 'hono';
import type { Logger } from 'pino';
import type { AppEnv } from '../types.js';
import { StackPermissionError, StackValidationError, StackNotFoundError } from '@haverstack/core';

export function errorMiddleware(logger: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof StackNotFoundError) return c.json({ error: 'Not found' }, 404);
    if (err instanceof StackPermissionError) return c.json({ error: 'Forbidden' }, 403);
    if (err instanceof StackValidationError)
      return c.json({ error: err.message, details: err.errors }, 422);
    logger.error({ err, requestId: c.get('requestId') }, 'Unhandled request error');
    return c.json({ error: 'Internal server error' }, 500);
  };
}
