import { LocalAdapter, NativeTokenStore, defaultTokenStorePath } from '@haverstack/adapter-local';
import {
  ARTICLE,
  BOOKMARK,
  CONTACT,
  NOTE,
  PAGE,
  PHOTO,
  PLACE,
  TASK,
  defineCommonsTypes,
} from '@haverstack/commons';
import { Stack } from '@haverstack/core';
import type { StackTokenStore } from '@haverstack/core/wire';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { AuthNonceStore, defaultNonceStorePath } from './lib/nonceStore.js';
import { QueryWorkerPool } from './lib/queryWorker/pool.js';
import { ChangeStreamRegistry } from './lib/changeStreams.js';

export type StackContext = {
  adapter: LocalAdapter;
  stack: Stack;
  // Typed as the interface, not NativeTokenStore, so routes and middleware
  // bind to the contract. close() is the one lifecycle hook every
  // implementation needs and the core interface doesn't declare.
  tokens: StackTokenStore & { close(): Promise<void> };
  // DID challenge-response nonces — see AuthNonceStore. Also kept outside
  // the portable stack file, in its own sibling store beside the tokens.
  nonces: AuthNonceStore;
  // Runs ScopedStack.query() off the request thread with a per-request
  // deadline. See docs/spec/wire-format.md § Bounding query cost and
  // src/lib/queryWorker/pool.ts.
  queryWorker: QueryWorkerPool;
  // Open GET /changes SSE connections, so shutdown can end them promptly
  // rather than waiting out the drain timeout. See src/lib/changeStreams.ts.
  changeStreams: ChangeStreamRegistry;
};

export async function initStack(config: Config, logger: Logger): Promise<StackContext> {
  // openOrInitialize() decides between open and create without a TOCTOU
  // gap. entityId goes in as a lazy provider so openOrInitialize()'s own
  // owner-mismatch check, which throws, never runs on the open path —
  // ENTITY_ID divergence is a warning below, not a failure — and so a
  // missing ENTITY_ID is an error only when creating a database.
  const adapter = await LocalAdapter.openOrInitialize({
    path: config.dbPath,
    entityId: () => {
      if (!config.entityId) {
        throw new Error(
          'ENTITY_ID is required when initializing a new database (DB_PATH does not exist yet)',
        );
      }
      return config.entityId;
    },
    timezone: config.timezone,
  });

  if (config.entityId && config.entityId !== adapter.ownerEntityId) {
    logger.warn(
      { configuredEntityId: config.entityId, storedOwnerEntityId: adapter.ownerEntityId },
      "ENTITY_ID does not match the stack's stored owner; the configured value is ignored",
    );
  }

  const stack = await Stack.create(
    adapter,
    config.ownerName
      ? { ownerProfile: { name: config.ownerName, handle: config.ownerHandle ?? undefined } }
      : undefined,
  );

  // Opt-in (SEED_COMMONS_TYPES). defineType() is idempotent — an identical
  // schema is a no-op preserving createdAt — so this is safe every boot.
  if (config.seedCommonsTypes) {
    await defineCommonsTypes(stack, [NOTE, BOOKMARK, TASK, CONTACT, ARTICLE, PLACE, PAGE, PHOTO]);
  }

  // Composed as a separate part rather than sniffed off the adapter: auth
  // material lives in its own file beside stack.db (not inside the
  // portable stack export) per docs/spec/wire-format.md § Authentication.
  const tokens = await NativeTokenStore.open({ path: defaultTokenStorePath(config.dbPath) });
  const nonces = AuthNonceStore.open(defaultNonceStorePath(config.dbPath));

  // Spawned only once the adapter has opened and seeded stack.db: each
  // worker opens its own connection to that same file, and idempotent
  // seeding makes the race survivable rather than worth running.
  const queryWorker = new QueryWorkerPool({
    init: { dbPath: config.dbPath },
    poolSize: config.queryWorkerPoolSize,
    queueLimit: config.queryQueueLimit,
    logger,
  });

  return { adapter, stack, tokens, nonces, queryWorker, changeStreams: new ChangeStreamRegistry() };
}
