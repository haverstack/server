import type { TokenSession } from '@haverstack/core/wire';

/** Hono context variable map shared across all route files. */
export type AppEnv = {
  Variables: {
    auth: TokenSession | null;
    requestId: string;
  };
};
