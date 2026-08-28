import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { Config } from '../config.js';
import type {
  ScopedStack,
  TokenSession,
  ChangeFilter,
  ChangeKind,
  RecordChange,
} from '@haverstack/core';
import { StackQueryError } from '@haverstack/core';
import { serializeChange } from '@haverstack/wire-types';
import type { ChangeResetReason } from '@haverstack/wire-types';
import { FrameGate } from '../lib/frameGate.js';

const CHANGE_KINDS: ReadonlySet<ChangeKind> = new Set(['created', 'changed', 'deleted', 'purged']);

// How often a `: keepalive` comment goes out on an otherwise-idle
// connection, and how often an authenticated session is re-checked against
// the token store — a stream's authority is fixed at connect, so without
// this a revoked or expired token would keep delivering for as long as the
// connection stays open. Neither is part of the wire contract (a client
// never sees these values), so they're plain constants rather than another
// pair of env vars.
const DEFAULT_KEEPALIVE_MS = 15_000;
const DEFAULT_SESSION_CHECK_MS = 30_000;
// A slow or stalled client whose in-flight frame count crosses this is
// closed rather than left to queue indefinitely — "close on overflow,
// never drop a frame silently" (#82): a client that can't tell it missed
// something can't repair it either, so silently dropping is worse than
// disconnecting.
const DEFAULT_MAX_PENDING_FRAMES = 1000;

export type ChangeRouteOptions = {
  keepaliveMs?: number;
  sessionCheckMs?: number;
  maxPendingFrames?: number;
};

/** Parse GET /changes' query params into a ChangeFilter. Exact, not advisory. */
function parseChangeFilter(url: URL): ChangeFilter {
  const filter: ChangeFilter = {};

  const typeIds = url.searchParams.getAll('typeId');
  if (typeIds.length) filter.typeId = typeIds.length === 1 ? typeIds[0] : typeIds;

  const parentId = url.searchParams.get('parentId');
  if (parentId !== null) filter.parentId = parentId === 'null' ? null : parentId;

  const entityId = url.searchParams.get('entityId');
  if (entityId !== null) filter.entityId = entityId;

  const kinds = url.searchParams.getAll('kind');
  if (kinds.length) {
    for (const kind of kinds) {
      if (!CHANGE_KINDS.has(kind as ChangeKind))
        throw new StackQueryError(`Invalid kind: "${kind}"`);
    }
    filter.kinds = kinds as ChangeKind[];
  }

  return filter;
}

/** Whether `?include=record` was requested. Any other value is a 400. */
function parseIncludeRecord(url: URL): boolean {
  const include = url.searchParams.get('include');
  if (include === null) return false;
  if (include !== 'record') throw new StackQueryError(`Invalid include: "${include}"`);
  return true;
}

/**
 * A connection presenting a cursor this server can't honor. Resume isn't
 * implemented yet (#84) — every connection ships `resume: false` and
 * answers `reset` here, which is fully conformant: a client's repair is the
 * same reconcile-by-query work as a fresh connection.
 */
function presentedCursor(c: Context<AppEnv>, url: URL): boolean {
  return c.req.header('Last-Event-ID') !== undefined || url.searchParams.get('since') !== null;
}

export function changeRoutes(
  ctx: StackContext,
  config: Config,
  opts: ChangeRouteOptions = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const sessionCheckMs = opts.sessionCheckMs ?? DEFAULT_SESSION_CHECK_MS;
  const maxPendingFrames = opts.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;

  /** Scope to a session if authenticated, else the anonymous (public-only) view. */
  function scopeFor(auth: TokenSession | null): ScopedStack {
    return auth ? ctx.stack.forSession(auth) : ctx.stack.asEntity(null);
  }

  // Single-process only: events exist only in the process that owns the
  // stack's storage (docs/spec/wire-format.md § Feed implementation
  // checklist). This server is one process today and
  // src/lib/queryWorker/ only reads, so ctx.stack.subscribe() sees every
  // local write — but a second process subscribing to its own Stack over
  // the same storage would see nothing and look fine in testing. Worth
  // knowing before this server is ever scaled horizontally.
  app.get('/', async (c) => {
    const url = new URL(c.req.url);
    const auth = c.get('auth');
    const filter = parseChangeFilter(url);
    const includeRecords = parseIncludeRecord(url);
    const resetOnConnect = presentedCursor(c, url);

    // Never accepted: a bearer token is read only from the Authorization
    // header (authMiddleware), never from a query param — the feed is
    // consumed via fetch with a streaming body precisely so a client never
    // needs to put a credential somewhere a browser might log or cache it.
    const bearerToken = c.req.header('Authorization')?.slice('Bearer '.length);

    return streamSSE(c, async (stream) => {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      stream.onAbort(() => resolveDone());
      const unregister = ctx.changeStreams.add(() => resolveDone());

      const gate = new FrameGate(maxPendingFrames, () => resolveDone());
      function send(event: string, data: unknown): void {
        gate.send(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
      }

      send('ready', {});
      if (resetOnConnect) {
        const reason: ChangeResetReason = 'not_supported';
        send('reset', { reason });
      }

      const unsubscribe = await scopeFor(auth).subscribe(
        (change: RecordChange) => {
          send('record', serializeChange(change));
        },
        { filter, includeRecords },
      );

      const keepalive = setInterval(() => {
        void stream.write(': keepalive\n\n');
      }, keepaliveMs);

      // A revoked or expired token must stop delivering. The owner's
      // static bearer token never expires (authMiddleware compares it
      // directly, not via the token store), so only a minted session needs
      // re-checking; an anonymous connection has no token to revoke.
      const isOwnerToken = bearerToken === config.ownerToken;
      const sessionCheck =
        auth && !isOwnerToken && bearerToken
          ? setInterval(() => {
              void ctx.tokens.lookupToken(bearerToken).then((session) => {
                if (!session) resolveDone();
              });
            }, sessionCheckMs)
          : undefined;

      await done;

      clearInterval(keepalive);
      if (sessionCheck) clearInterval(sessionCheck);
      unsubscribe();
      unregister();
    });
  });

  return app;
}
