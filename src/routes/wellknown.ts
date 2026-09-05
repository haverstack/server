import { Hono } from 'hono';
import {
  WIRE_PROTOCOL_VERSION,
  AUTH_METHOD_DID_CHALLENGE,
  CHANGE_TRANSPORT_SSE,
} from '@haverstack/wire-types';
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
        limits: {
          attachmentBytes: config.maxAttachmentBytes,
          contentBytes: config.maxContentBytes,
        },
      },
      // The DID challenge-response handshake is always implemented by this
      // server, so it's always advertised — a client holding a DID
      // credential learns at open() that there's a handshake to perform,
      // rather than discovering it as a 404 partway through one.
      auth: { methods: [AUTH_METHOD_DID_CHALLENGE] },
      // Top-level rather than inside `capabilities`, which carries only
      // what the `...ctx.stack.features` spread brings. An object rather
      // than a boolean for the same reason `auth` is: the surface grows
      // entries — another transport, batched frames — not more booleans.
      //
      // Both flags are literals with no override: GET /changes does resume
      // and does honor `?include=record`, and a client acts on this answer
      // without asking again. An override could only ever make discovery
      // lie about the route beside it.
      changes: {
        transports: [CHANGE_TRANSPORT_SSE],
        resume: true,
        records: true,
      },
    };
    return c.json(body);
  });

  return app;
}
