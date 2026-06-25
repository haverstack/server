import { LocalAdapter } from '@haverstack/adapter-local';
import { Stack } from '@haverstack/core';
import type { Config } from './config.js';

export type StackContext = {
  adapter: LocalAdapter;
  stack: Stack;
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
  return { adapter, stack };
}
