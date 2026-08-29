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
import { serializeChange, isValidSeq } from '@haverstack/wire-types';
import type { ChangeResetReason } from '@haverstack/wire-types';
import type { Logger } from 'pino';
import { safeCompare } from '../middleware/auth.js';
import { FrameGate } from '../lib/frameGate.js';
import { decodeCursor } from '../lib/resumeCursor.js';
import { resumeBufferKey, type ResumeEntry } from '../lib/resumeBuffer.js';

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
  /**
   * Whether a presented cursor is honored at all. Default true. Exists
   * only so a test can exercise the `resume: false` branch of the wire
   * contract (see WellknownRouteOptions.changeFeedResume) — there's no
   * real deployer lever here once #84 lands.
   */
  resume?: boolean;
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
 * Raw cursor text presented on this connection, if any — `Last-Event-ID`
 * takes priority over `?since=` (a browser EventSource-style reconnect
 * sends the header; `?since=` exists for a client whose transport can't
 * set one). Not yet validated or decoded — see isValidSeq()/decodeCursor().
 */
function presentedCursorRaw(c: Context<AppEnv>, url: URL): string | undefined {
  return c.req.header('Last-Event-ID') ?? url.searchParams.get('since') ?? undefined;
}

export function changeRoutes(
  ctx: StackContext,
  config: Config,
  logger: Logger,
  opts: ChangeRouteOptions = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const sessionCheckMs = opts.sessionCheckMs ?? DEFAULT_SESSION_CHECK_MS;
  const maxPendingFrames = opts.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
  const resumeEnabled = opts.resume ?? true;
  // Owned by StackContext, not minted here: a buffer outlives the
  // connection that created it, so its lifetime belongs to the process
  // rather than to this router. See src/stack.ts.
  const resumeBuffers = ctx.resumeBuffers;

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
    const presentedRaw = presentedCursorRaw(c, url);

    // A charset-invalid cursor is refused locally rather than treated as a
    // cache miss — it isn't a value this (or any conformant) server could
    // ever have minted, so there's nothing to reconcile by resuming from
    // it. isValidSeq() is the same rule this server's own minted cursors
    // are held to on the way out.
    if (resumeEnabled && presentedRaw !== undefined && !isValidSeq(presentedRaw)) {
      throw new StackQueryError(`Invalid cursor: "${presentedRaw}"`);
    }

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
      /** Returns false once the gate has tripped — this connection is closing. */
      function send(event: string, data: unknown, id?: string): boolean {
        return gate.send(() =>
          stream.writeSSE({ event, data: JSON.stringify(data), ...(id !== undefined && { id }) }),
        );
      }

      // Assigned inside the try below; torn down in the finally whether the
      // connection ended by abort, by a revoked session, or by a throw. A
      // throw is caught rather than left to hono, which would answer it by
      // writing the raw error message to the client as an `error` frame.
      let unsubscribe: (() => void) | undefined;
      let keepalive: NodeJS.Timeout | undefined;
      let sessionCheck: NodeJS.Timeout | undefined;

      try {
        if (!resumeEnabled) {
          // `resume: false` — a discovery-conformant server that mints no
          // cursors at all. Exists only for WellknownRouteOptions'
          // matching test toggle; every connection here is answered exactly
          // as #82 shipped it.
          send('ready', {});
          if (presentedRaw !== undefined) {
            const reason: ChangeResetReason = 'not_supported';
            send('reset', { reason });
          }
          unsubscribe = await scopeFor(auth).subscribe(
            (change: RecordChange) => {
              send('record', serializeChange(change));
            },
            { filter, includeRecords },
          );
        } else {
          const key = resumeBufferKey({
            principalId: auth?.principalId ?? null,
            subjectId: auth?.subjectId ?? null,
            filter,
            includeRecords,
          });
          const scoped = scopeFor(auth);
          const buffer = await resumeBuffers.acquire(key, (onChange) =>
            scoped.subscribe(onChange, { filter, includeRecords }),
          );

          // Attached before anything below reads or awaits, so nothing this
          // connection is owed can land in the gap between "what the backlog
          // snapshot covers" and "what the live buffer starts reporting" —
          // there isn't one. `replaying` buffers what arrives live while the
          // (possibly awaited, permission-rechecking) backlog replay below is
          // still in flight, so a change appended mid-replay can never be
          // sent out of order ahead of an older, still-pending backlog frame.
          let replaying = true;
          const queued: ResumeEntry[] = [];
          const detachLive = buffer.subscribeLive((entry) => {
            if (replaying) queued.push(entry);
            else send('record', entry.frame, entry.frame.seq);
          });
          // Registered before the first `await` below, so a subscription
          // opened above is always released — including when that await
          // throws. Everything after this point runs under the finally.
          unsubscribe = () => {
            detachLive();
            resumeBuffers.release(key);
          };

          let resetReason: ChangeResetReason | undefined;
          let backlog: ResumeEntry[] = [];
          if (presentedRaw !== undefined) {
            const decoded = decodeCursor(presentedRaw);
            if (!decoded || decoded.bufferId !== buffer.id) {
              // Unrecognized outright, or names a buffer instance that isn't
              // this key's current one (evicted past its retention window,
              // or minted for a filter this cursor doesn't actually match).
              resetReason = 'cursor_expired';
            } else {
              const outcome = buffer.entriesAfter(decoded.n);
              if (outcome.status === 'ok') backlog = outcome.entries;
              else resetReason = outcome.status;
            }
          }

          send('ready', { seq: buffer.headCursor() });

          if (resetReason) {
            send('reset', { reason: resetReason });
          } else {
            for (const entry of backlog) {
              // Purge frames aren't re-checkable — the mutation-time decision
              // is the only one that will ever exist (docs/spec/events.md,
              // quoted on issue #84). A non-purge frame's record ID is still
              // in hand, so a grant revoked during the gap is caught here.
              if (!entry.isPurge) {
                const stillReadable = await scoped.get(entry.recordId);
                if (!stillReadable) continue;
              }
              // Once the gate trips this connection is closing, so the
              // remaining entries are permission checks nobody will read.
              if (!send('record', entry.frame, entry.frame.seq)) break;
            }
          }

          replaying = false;
          for (const entry of queued) {
            if (!send('record', entry.frame, entry.frame.seq)) break;
          }
        }

        // Through the gate like any other write: a client not draining its
        // keepalives isn't draining anything, and counting them is what
        // keeps "in-flight frames are bounded" true of the whole stream
        // rather than of `record` frames alone.
        keepalive = setInterval(() => {
          gate.send(() => stream.write(': keepalive\n\n'));
        }, keepaliveMs);

        // A revoked or expired token must stop delivering. The owner's
        // static bearer token never expires (authMiddleware compares it
        // directly, not via the token store), so only a minted session needs
        // re-checking; an anonymous connection has no token to revoke.
        const isOwnerToken =
          bearerToken !== undefined && safeCompare(bearerToken, config.ownerToken);
        sessionCheck =
          auth && !isOwnerToken && bearerToken
            ? setInterval(() => {
                void ctx.tokens.lookupToken(bearerToken).then(
                  (session) => {
                    if (!session) resolveDone();
                  },
                  // The token store is unreachable. Closing is the honest
                  // answer — the client reconnects and re-authenticates
                  // through the path that already handles a 401 — and it
                  // keeps a rejection here from going unhandled.
                  () => resolveDone(),
                );
              }, sessionCheckMs)
            : undefined;

        await done;
      } catch (err) {
        // Hono answers a throw from this callback by writing the raw error
        // message to the client as an `error` frame; catching it here keeps
        // internal detail off a stream any anonymous caller can open, and
        // the closed connection is already a repair the client knows how to
        // make (reconnect, present the cursor, take frames or a `reset`).
        logger.error(
          { err, requestId: c.get('requestId') },
          'Change feed connection ended with an error',
        );
      } finally {
        if (keepalive) clearInterval(keepalive);
        if (sessionCheck) clearInterval(sessionCheck);
        unsubscribe?.();
        unregister();
      }
    });
  });

  return app;
}
