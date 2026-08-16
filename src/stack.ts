import { LocalAdapter, NativeTokenStore, defaultTokenStorePath } from '@haverstack/adapter-local';
import { Stack } from '@haverstack/core';
import type { StackTokenStore } from '@haverstack/core/wire';
import type { Config } from './config.js';

export type StackContext = {
  adapter: LocalAdapter;
  stack: Stack;
  // The interface (not NativeTokenStore) everywhere except lifecycle:
  // routes and middleware should type against StackTokenStore, same
  // reasoning as not sniffing token methods off the adapter. close() is
  // the one lifecycle hook every implementation needs but the core
  // interface doesn't declare.
  tokens: StackTokenStore & { close(): Promise<void> };
};

export async function initStack(config: Config): Promise<StackContext> {
  let adapter: LocalAdapter;

  if (config.isNewDb) {
    adapter = await LocalAdapter.initialize({
      path: config.dbPath,
      entityId: config.entityId!,
      timezone: config.timezone,
    });
  } else {
    adapter = await LocalAdapter.open({ path: config.dbPath });
  }

  const stack = await Stack.create(adapter);

  // Composed as a separate part rather than sniffed off the adapter: auth
  // material lives in its own file beside stack.db (not inside the
  // portable stack export) per docs/spec/wire-format.md § Authentication.
  const tokens = await NativeTokenStore.open({ path: defaultTokenStorePath(config.dbPath) });

  return { adapter, stack, tokens };
}
