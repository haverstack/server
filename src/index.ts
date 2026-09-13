/**
 * @haverstack/server's library surface. The package is primarily an app
 * (`dist/main.js`, run via `pnpm start` / the Docker image — see
 * src/main.ts), but these exports let a consumer build and run the same
 * Hono app in-process: embedding it behind their own listener, or driving a
 * real instance in tests. See `@haverstack/server/testing` for the latter.
 */

export { createApp } from './app.js';
export type { AppEnv } from './types.js';
export { initStack } from './stack.js';
export type { StackContext } from './stack.js';
export { loadConfig } from './config.js';
export type { Config } from './config.js';
export { createShutdownHandler } from './shutdown.js';
export type { ShutdownServer } from './shutdown.js';
