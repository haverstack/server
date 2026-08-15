import type { TokenSession } from '@haverstack/core';

/** Hono context variable map shared across all route files. */
export type AppEnv = {
  Variables: {
    auth: TokenSession | null;
    requestId: string;
  };
};
