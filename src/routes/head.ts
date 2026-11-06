import { Hono } from 'hono';
import type { WireHeadResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireAuth } from '../middleware/auth.js';
import { scopeFor } from '../lib/scope.js';

/**
 * GET /head — where the store's writes stand, so the owner reading it in
 * full learns whether anything was written meanwhile. Answered from the
 * adapter every write goes through; query workers only read.
 * ScopedStack.head() refuses all but the owner acting alone: a head moves
 * on writes to Records the requester cannot read. Mounted only when the
 * stack has head(). See docs/spec/wire-format.md § Head.
 */
export function headRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { stack } = ctx;

  app.get('/', knownParams(), requireAuth(), async (c) => {
    const body: WireHeadResponse = { head: await scopeFor(stack, c.get('auth')).head!() };
    return c.json(body);
  });

  return app;
}
