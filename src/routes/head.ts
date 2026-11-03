import { Hono } from 'hono';
import type { WireHeadResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import { knownParams } from '../middleware/params.js';
import type { StackContext } from '../stack.js';
import { requireOwner } from '../middleware/auth.js';

/**
 * GET /head — where the store's writes stand, so the owner reading it in
 * full learns whether anything was written meanwhile. Answered from the
 * adapter every write goes through; query workers only read. Owner acting
 * alone: a head moves on writes to Records the requester cannot read.
 * See docs/spec/wire-format.md § Head.
 */
export function headRoutes(ctx: StackContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { adapter, stack } = ctx;

  app.get('/', knownParams(), requireOwner(stack.ownerEntityId), async (c) => {
    const body: WireHeadResponse = { head: await adapter.head() };
    return c.json(body);
  });

  return app;
}
