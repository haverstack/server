import { Hono } from 'hono';
import { WIRE_PROTOCOL_VERSION } from '@haverstack/wire-types';
import type { DiscoveryResponse } from '@haverstack/wire-types';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { Config } from '../config.js';

export function wellknownRoutes(ctx: StackContext, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/stack', (c) => {
    const body: DiscoveryResponse = {
      version: WIRE_PROTOCOL_VERSION,
      entityId: ctx.stack.ownerEntityId,
      timezone: ctx.stack.timezone,
      // The server's own request-size ceilings are authoritative here,
      // overriding the adapter's `null` — nothing at the storage layer
      // imposes a limit, but this server enforces both. See
      // docs/spec/wire-format.md § Discovery.
      capabilities: {
        ...ctx.stack.features,
        maxAttachmentBytes: config.maxAttachmentBytes,
        maxContentBytes: config.maxContentBytes,
      },
    };
    return c.json(body);
  });

  return app;
}
