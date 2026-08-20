import { LocalAdapter, NativeTokenStore, defaultTokenStorePath } from '@haverstack/adapter-local';
import { Stack } from '@haverstack/core';
import type { StackTokenStore } from '@haverstack/core/wire';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { AuthNonceStore, defaultNonceStorePath } from './lib/nonceStore.js';

export type StackContext = {
  adapter: LocalAdapter;
  stack: Stack;
  // The interface (not NativeTokenStore) everywhere except lifecycle:
  // routes and middleware should type against StackTokenStore, same
  // reasoning as not sniffing token methods off the adapter. close() is
  // the one lifecycle hook every implementation needs but the core
  // interface doesn't declare.
  tokens: StackTokenStore & { close(): Promise<void> };
  // DID challenge-response nonces — see AuthNonceStore. Also kept outside
  // the portable stack file, in its own sibling store beside the tokens.
  nonces: AuthNonceStore;
};

export async function initStack(config: Config, logger: Logger): Promise<StackContext> {
  // openOrInitialize() collapses the existsSync-then-branch choreography
  // (a TOCTOU: the file can change state between the check and the call)
  // into one race-free operation. entityId is passed as a lazy provider
  // rather than a plain string so that openOrInitialize()'s own
  // owner-mismatch check — which throws — never runs on the open path;
  // ENTITY_ID divergence from an existing stack is a warning here, not a
  // hard failure, matching documented behavior ("ignored once the
  // database exists"). The provider itself is only invoked when a new
  // database is actually being created, so a missing ENTITY_ID is never
  // an error when opening an existing one.
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

  // Composed as a separate part rather than sniffed off the adapter: auth
  // material lives in its own file beside stack.db (not inside the
  // portable stack export) per docs/spec/wire-format.md § Authentication.
  const tokens = await NativeTokenStore.open({ path: defaultTokenStorePath(config.dbPath) });
  const nonces = AuthNonceStore.open(defaultNonceStorePath(config.dbPath));

  return { adapter, stack, tokens, nonces };
}
