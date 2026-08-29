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
        maxAttachmentBytes: config.maxAttachmentBytes,
        maxContentBytes: config.maxContentBytes,
      },
      // The DID challenge-response handshake is always implemented by this
      // server, so it's always advertised — a client holding a DID
      // credential learns at open() that there's a handshake to perform,
      // rather than discovering it as a 404 partway through one.
      auth: { methods: [AUTH_METHOD_DID_CHALLENGE] },
      // A top-level field, not part of `capabilities` above — it does not
      // come along with the `...ctx.stack.features` spread the way the
      // adapter's own capabilities do, so it's added explicitly. An object
      // rather than a boolean for the same reason `auth` is: the surface
      // grows entries (another transport, batched frames) rather than
      // gaining a second and third boolean alongside it.
      //
      // Both literals, with no override: this server resumes (#84 mints
      // cursors and GET /changes honors Last-Event-ID/?since=) and honors
      // `?include=record` (#82), so those are the only true answers it can
      // give. A client is entitled to act on this without asking again —
      // `APIAdapter.subscribeChanges()` against a server advertising no
      // feed throws locally, without sending a request — which makes an
      // override that could report otherwise a way to make this response
      // lie about the route next to it. The conformant both-false shape is
      // a different server's discovery response, not a mode of this one;
      // the fixture describing it is skipped in tests/conformance.test.ts
      // for exactly that reason.
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
