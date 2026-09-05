import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../types.js';
import type { StackContext } from '../stack.js';
import type { Config } from '../config.js';
import type { ScopedStack, TokenSession, RecordChange } from '@haverstack/core';
import { StackQueryError, StackPermissionError } from '@haverstack/core';
import { parseChangeParams } from '@haverstack/core/wire';
import { serializeChange, isValidSeq } from '@haverstack/wire-types';
import type { ChangeResetReason } from '@haverstack/wire-types';
import type { Logger } from 'pino';
import { safeCompare, isOwnerActingAlone } from '../middleware/auth.js';
import { FrameGate } from '../lib/frameGate.js';
import { decodeCursor } from '../lib/resumeCursor.js';
import { ResumeBufferRegistry, resumeBufferKey, type ResumeEntry } from '../lib/resumeBuffer.js';

// Keepalive cadence, and how often an authenticated session is re-checked
// against the token store — a stream's authority is fixed at connect, so
// without the re-check a revoked token keeps delivering for as long as the
// connection lives. Neither value reaches a client, so neither is an env var.
const DEFAULT_KEEPALIVE_MS = 15_000;
const DEFAULT_SESSION_CHECK_MS = 30_000;
// A client whose in-flight frame count crosses this is closed rather than
// left to queue: one that can't tell it missed a frame can't repair it
// either, so dropping silently is worse than disconnecting.
const DEFAULT_MAX_PENDING_FRAMES = 1000;
// Per-buffer ring depth and how long a buffer keeps being fed after its
// last connection disconnects — see src/lib/resumeBuffer.ts. Not part of
// the wire contract either: a client never learns these numbers, only
// their consequence (`overflow` or `cursor_expired`).
const DEFAULT_RESUME_BUFFER_DEPTH = 1000;
const DEFAULT_RESUME_RETENTION_MS = 5 * 60 * 1000;

export type ChangeRouteOptions = {
  keepaliveMs?: number;
  sessionCheckMs?: number;
  maxPendingFrames?: number;
  /**
   * Whether a presented cursor is honored at all. Default true and never
   * false in production, since discovery advertises resume unconditionally.
   * It exists because `resume: false` is real, spec-defined behavior
   * (`ready` with no `seq`, then `reset` with reason `not_supported`) that
   * a conformance fixture needs a way to reach.
   */
  resume?: boolean;
  resumeBufferDepth?: number;
  resumeRetentionMs?: number;
};

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
  const resumeBuffers = new ResumeBufferRegistry({
    depth: opts.resumeBufferDepth ?? DEFAULT_RESUME_BUFFER_DEPTH,
    retentionMs: opts.resumeRetentionMs ?? DEFAULT_RESUME_RETENTION_MS,
  });

  /** Scope to a session if authenticated, else the anonymous (public-only) view. */
  function scopeFor(auth: TokenSession | null): ScopedStack {
    return auth ? ctx.stack.forSession(auth) : ctx.stack.asEntity(null);
  }

  // Single-process only: events exist only in the process owning the
  // stack's storage (docs/spec/wire-format.md § Feed implementation
  // checklist), and query workers only read. A second process subscribing
  // to its own Stack over the same storage would see nothing and look fine
  // in testing — worth knowing before scaling this horizontally.
  app.get('/', async (c) => {
    const url = new URL(c.req.url);
    const auth = c.get('auth');
    const { filter, includeRecords, includeUnlisted } = parseChangeParams(url);
    const presentedRaw = presentedCursorRaw(c, url);

    // Refused before the stream opens: a throw from subscribe() after
    // streaming starts is caught below and merely closes the connection,
    // silently, having already answered 200. includeUnlisted owes a real
    // 403, the same one GET /records answers with.
    if (includeUnlisted && !isOwnerActingAlone(auth, ctx.stack.ownerEntityId)) {
      throw new StackPermissionError('includeUnlisted is owner-only');
    }

    // A charset-invalid cursor is refused rather than treated as a cache
    // miss: no conformant server could have minted it, so there is nothing
    // to reconcile. isValidSeq() is the rule minted cursors meet on the way
    // out, applied here on the way in.
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
          // cursors at all, reachable only through WellknownRouteOptions'
          // matching test toggle.
          send('ready', {});
          if (presentedRaw !== undefined) {
            const reason: ChangeResetReason = 'not_supported';
            send('reset', { reason });
          }
          unsubscribe = await scopeFor(auth).subscribe(
            (change: RecordChange) => {
              send('record', serializeChange(change));
            },
            { filter, includeRecords, includeUnlisted },
          );
        } else {
          const key = resumeBufferKey({
            principalId: auth?.principalId ?? null,
            subjectId: auth?.subjectId ?? null,
            filter,
            includeRecords,
            includeUnlisted,
          });
          const scoped = scopeFor(auth);
          const buffer = await resumeBuffers.acquire(key, (onChange) =>
            scoped.subscribe(onChange, { filter, includeRecords, includeUnlisted }),
          );

          // Attached before anything below awaits, so there is no gap
          // between what the backlog snapshot covers and what the live
          // buffer reports. `replaying` holds live arrivals until the
          // permission-rechecking replay finishes, so a change appended
          // mid-replay can't overtake an older, still-pending backlog frame.
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
              // A purge frame isn't re-checkable: the mutation-time
              // decision is the only one there will ever be
              // (docs/spec/events.md). Everything else still has its record
              // ID, so a grant revoked during the gap is caught here.
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
        // Hono answers an uncaught throw here by writing the raw error
        // message to the client as an `error` frame. Catching keeps internal
        // detail off a stream any anonymous caller can open, and a closed
        // connection is a repair the client already knows how to make.
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
