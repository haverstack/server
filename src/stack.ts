import { SQLiteAdapter } from '@haverstack/adapter-sqlite';
import { Stack } from '@haverstack/core';
import type { Config } from './config.js';

export type StackContext = {
  adapter: SQLiteAdapter;
  stack: Stack;
};

export async function initStack(config: Config): Promise<StackContext> {
  let adapter: SQLiteAdapter;

  if (config.isNewDb) {
    adapter = await SQLiteAdapter.initialize({
      path: config.dbPath,
      entityId: config.entityId!,
      timezone: config.timezone,
    });
  } else {
    adapter = await SQLiteAdapter.open({ path: config.dbPath });
  }

  const stack = await Stack.create(adapter);
  return { adapter, stack };
}
