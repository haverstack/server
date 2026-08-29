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

export type WellknownRouteOptions = {
  /**
   * Whether `?include=record` is honored on `GET /changes`. Always `true`
   * in production — `src/routes/changes.ts` honors it unconditionally, so
   * there's no real deployer lever here. This exists only so a test can
   * exercise the `records: false` branch of the wire contract (both flags
   * false is fully conformant — see docs/spec/wire-format.md § Change
   * feed) without `src/routes/changes.ts` growing a matching toggle it
   * doesn't otherwise need.
   */
  changeFeedRecords?: boolean;
};

export function wellknownRoutes(
  ctx: StackContext,
  config: Config,
  opts: WellknownRouteOptions = {},
): Hono<AppEnv> {
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
      // gaining a second and third boolean alongside it. Advertise what's
      // true, not what's aspirational — a client that calls
      // subscribeChanges() against a server advertising no feed fails
      // locally at open(), which is strictly better than discovering a 404
      // partway through a connection. `resume: false` until #84 mints
      // cursors; `records: true` because `GET /changes` already honors
      // `?include=record` unconditionally (#82).
      changes: {
        transports: [CHANGE_TRANSPORT_SSE],
        resume: false,
        records: opts.changeFeedRecords ?? true,
      },
    };
    return c.json(body);
  });

  return app;
}
